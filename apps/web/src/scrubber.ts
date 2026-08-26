/**
 * DEADRECKON :: THE SCRUBBER.
 *
 * Always present, never modal, and there is no record button anywhere in
 * this application.
 *
 * That is the entire difference from a live map. When something happens,
 * you do not go and turn on capture -- you drag left, because the worker
 * never stopped writing and the archive already contains the hour before
 * anyone was paying attention.
 */

export interface ScrubberOpts {
  canvas: HTMLCanvasElement;
  track: HTMLElement;
  cursor: HTMLElement;
  clock: HTMLElement;
  /** null means "resume live". */
  onSeek: (atMs: number | null) => void;
}

const RATES = [1, 10, 60, 300];

export class Scrubber {
  private from = Date.now() - 3600_000;
  private to = Date.now();
  private at: number | null = null;
  private playing = false;
  private rateIdx = 1;
  private raf = 0;
  private lastFrame = 0;
  private density: { t: number; v: number }[] = [];

  constructor(private readonly o: ScrubberOpts) {
    o.track.addEventListener('pointerdown', (e) => {
      o.track.setPointerCapture(e.pointerId);
      this.scrubTo(e);
    });
    o.track.addEventListener('pointermove', (e) => {
      if (e.buttons) this.scrubTo(e);
    });
    o.track.addEventListener('wheel', (e) => {
      e.preventDefault();
      const span = this.to - this.from;
      this.seekRelative(Math.sign(e.deltaY) * span * 0.02);
    });

    new ResizeObserver(() => this.draw()).observe(o.track);
    this.paint();
  }

  setWindow(from: number, to: number): void {
    this.from = from;
    this.to = to;
    this.paint();
  }

  /** Detection times, drawn as tick marks so you can see where to look. */
  setDensity(points: { t: number; v: number }[]): void {
    this.density = points;
    this.draw();
  }

  goLive(): void {
    this.at = null;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.o.onSeek(null);
    this.paint();
  }

  seekRelative(deltaMs: number): void {
    const base = this.at ?? this.to;
    this.seekTo(base + deltaMs);
  }

  seekTo(ms: number): void {
    const clamped = Math.max(this.from, Math.min(this.to, ms));
    // Within 30s of the head, treat it as live rather than as a replay
    // pinned one tick behind reality.
    this.at = this.to - clamped < 30_000 ? null : clamped;
    this.o.onSeek(this.at);
    this.paint();
  }

  togglePlay(): void {
    if (this.at === null) this.at = this.to - 3600_000;
    this.playing = !this.playing;
    this.lastFrame = performance.now();
    if (this.playing) this.tick();
    else cancelAnimationFrame(this.raf);
    this.paint();
  }

  cycleRate(): void {
    this.rateIdx = (this.rateIdx + 1) % RATES.length;
    this.paint();
  }

  private tick = (): void => {
    if (!this.playing || this.at === null) return;
    const now = performance.now();
    const dt = now - this.lastFrame;
    this.lastFrame = now;

    this.at += dt * RATES[this.rateIdx]!;
    if (this.at >= this.to) {
      this.goLive();
      return;
    }
    // The socket only needs a new anchor a few times a second.
    if (Math.random() < 0.25) this.o.onSeek(this.at);
    this.paint();
    this.raf = requestAnimationFrame(this.tick);
  };

  private scrubTo(e: PointerEvent): void {
    const r = this.o.track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    this.playing = false;
    this.seekTo(this.from + f * (this.to - this.from));
  }

  private paint(): void {
    const at = this.at ?? this.to;
    const f = (at - this.from) / Math.max(1, this.to - this.from);
    this.o.cursor.style.left = `${(f * 100).toFixed(3)}%`;

    const live = this.at === null;
    this.o.clock.classList.toggle('replay', !live);
    const d = new Date(at);
    this.o.clock.innerHTML =
      `<div class="lbl">${live ? 'LIVE' : this.playing ? `REPLAY ${RATES[this.rateIdx]}x` : 'HOLDING'}</div>` +
      `<div class="big">${d.toISOString().slice(11, 19)}Z</div>` +
      `<div class="lbl">${d.toISOString().slice(0, 10)} &middot; ${live ? 'head' : `T-${fmtBack(this.to - at)}`}</div>`;

    const rate = document.getElementById('sc-rate');
    if (rate) rate.textContent = `${RATES[this.rateIdx]}x`;
    const play = document.getElementById('sc-play');
    if (play) play.textContent = this.playing ? '❚❚' : '▶';

    this.draw();
  }

  /**
   * The timeline is drawn rather than composed from DOM nodes: a full day
   * of hour marks plus detection ticks is a few hundred strokes, and a
   * few hundred absolutely-positioned divs would be a scroll-jank machine.
   */
  private draw(): void {
    const c = this.o.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;

    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext('2d');
    if (!g) return;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const span = Math.max(1, this.to - this.from);
    const x = (t: number): number => ((t - this.from) / span) * w;

    // Archive extent: everything the system can show you without anyone
    // having decided in advance that it was worth keeping.
    g.fillStyle = 'rgba(0, 217, 255, 0.045)';
    g.fillRect(0, 0, w, h);

    // Hour and day graticule.
    const hours = span / 3600_000;
    const stepH = hours > 72 ? 24 : hours > 18 ? 6 : hours > 6 ? 1 : 0.25;
    const step = stepH * 3600_000;
    const first = Math.ceil(this.from / step) * step;

    g.font = '9px "JetBrains Mono", monospace';
    g.textBaseline = 'top';
    for (let t = first; t <= this.to; t += step) {
      const px = Math.round(x(t)) + 0.5;
      const major = new Date(t).getUTCHours() === 0;
      g.strokeStyle = major ? 'rgba(154,176,194,0.20)' : 'rgba(154,176,194,0.08)';
      g.beginPath();
      g.moveTo(px, major ? 0 : h * 0.55);
      g.lineTo(px, h);
      g.stroke();
      if (stepH >= 1 && (major || stepH >= 6)) {
        g.fillStyle = 'rgba(77,96,118,0.9)';
        g.fillText(
          major
            ? new Date(t).toISOString().slice(5, 10)
            : new Date(t).toISOString().slice(11, 16),
          px + 3,
          3,
        );
      }
    }

    // Detection ticks, height and colour by severity.
    for (const p of this.density) {
      const px = Math.round(x(p.t)) + 0.5;
      if (px < 0 || px > w) continue;
      const mag = Math.max(0.14, p.v / 100);
      g.strokeStyle =
        p.v >= 80
          ? 'rgba(255,45,85,0.92)'
          : p.v >= 60
            ? 'rgba(255,122,69,0.85)'
            : 'rgba(255,194,0,0.7)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, h);
      g.lineTo(px, h - mag * (h - 12));
      g.stroke();
    }

    // Head marker.
    g.strokeStyle = 'rgba(47,214,138,0.55)';
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(w - 0.5, 0);
    g.lineTo(w - 0.5, h);
    g.stroke();
    g.setLineDash([]);
  }
}

function fmtBack(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
