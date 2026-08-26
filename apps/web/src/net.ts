/**
 * DEADRECKON :: transport.
 *
 * Binary in, objects out. The socket carries 28-byte fixed records for
 * positions and JSON only for the handful of control and event messages,
 * so the hot path never allocates a string.
 *
 * Reconnect is not optional. A console that silently stops updating is
 * worse than one that says it is offline, because a frozen map looks
 * exactly like a quiet world.
 */

import {
  Msg,
  decodePositions,
  decodeRemove,
  decodeStrings,
  frameType,
  type WireRecord,
} from '@deadreckon/core';

export interface Contact extends WireRecord {
  id: string;
  label: string;
  updatedAt: number;
}

export interface EventMsg {
  kind: 'detection' | 'incident';
  id: number;
  rule?: string;
  severity: number;
  lat: number;
  lon: number;
  title: string;
  ts: number;
}

export interface NetHandlers {
  onContacts: (contacts: Map<number, Contact>, frameTimeMs: number) => void;
  onEvent: (e: EventMsg) => void;
  onStatus: (s: {
    connected: boolean;
    note: string;
    bytesIn: number;
    framesIn: number;
    lastFrameMs: number;
  }) => void;
}

const API =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ??
  window.location.origin;

const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `${API.replace(/^http/, 'ws')}/stream`;

export const apiUrl = (p: string): string => `${API}${p}`;

export class Net {
  private ws: WebSocket | null = null;
  private backoff = 800;
  private closed = false;

  /** ref -> id/label, populated by STRINGS frames. */
  private names = new Map<number, { id: string; label: string }>();
  readonly contacts = new Map<number, Contact>();

  bytesIn = 0;
  framesIn = 0;
  lastFrameMs = 0;

  private pendingSub: Record<string, unknown> | null = null;

  constructor(private readonly h: NetHandlers) {}

  connect(): void {
    this.closed = false;
    this.h.onStatus({ ...this.stat(), connected: false, note: 'connecting' });

    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 800;
      this.h.onStatus({ ...this.stat(), connected: true, note: 'linked' });
      if (this.pendingSub) ws.send(JSON.stringify(this.pendingSub));
    };

    ws.onmessage = (ev) => {
      const t0 = performance.now();
      if (typeof ev.data === 'string') {
        this.handleJson(ev.data);
      } else {
        this.handleBinary(ev.data as ArrayBuffer);
      }
      this.lastFrameMs = performance.now() - t0;
      this.framesIn++;
    };

    ws.onerror = () => {
      /* onclose always follows; nothing useful to do here */
    };

    ws.onclose = () => {
      this.ws = null;
      // Everything we knew came from a socket that is gone. Keeping the
      // contacts on screen would render a world that may no longer exist.
      this.names.clear();
      this.contacts.clear();
      this.h.onStatus({ ...this.stat(), connected: false, note: 'link down' });
      if (!this.closed) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const wait = Math.min(20_000, this.backoff) * (0.6 + Math.random() * 0.8);
    this.backoff = Math.min(20_000, this.backoff * 1.8);
    this.h.onStatus({
      ...this.stat(),
      connected: false,
      note: `retry in ${(wait / 1000).toFixed(1)}s`,
    });
    setTimeout(() => this.connect(), wait);
  }

  private handleJson(text: string): void {
    this.bytesIn += text.length;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.type === Msg.EVENT) this.h.onEvent(m as unknown as EventMsg);
  }

  private handleBinary(buf: ArrayBuffer): void {
    this.bytesIn += buf.byteLength;
    let t: number;
    try {
      t = frameType(buf);
    } catch {
      return;
    }

    if (t === Msg.STRINGS) {
      for (const s of decodeStrings(buf)) {
        this.names.set(s.ref, { id: s.id, label: s.label });
      }
      return;
    }

    if (t === Msg.REMOVE) {
      for (const ref of decodeRemove(buf)) this.contacts.delete(ref);
      this.h.onContacts(this.contacts, Date.now());
      return;
    }

    if (t === Msg.POSITIONS) {
      const f = decodePositions(buf);
      const now = Date.now();
      for (const r of f.records) {
        const n = this.names.get(r.ref);
        this.contacts.set(r.ref, {
          ...r,
          id: n?.id ?? `ref:${r.ref}`,
          label: n?.label ?? String(r.ref),
          updatedAt: now,
        });
      }
      this.h.onContacts(this.contacts, f.frameTimeMs);
    }
  }

  subscribe(
    bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
    domains: string[],
  ): void {
    const msg = { type: Msg.SUBSCRIBE, bbox, domains };
    this.pendingSub = msg;
    this.contacts.clear();
    this.names.clear();
    this.send(msg);
  }

  /** null resumes live. */
  seek(atMs: number | null): void {
    this.contacts.clear();
    this.names.clear();
    this.send({ type: Msg.SEEK, at: atMs });
  }

  private send(o: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  private stat() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      note: '',
      bytesIn: this.bytesIn,
      framesIn: this.framesIn,
      lastFrameMs: this.lastFrameMs,
    };
  }
}

/* ------------------------------------------------------------- REST */

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}
