/**
 * @deadreckon/core -- browser-safe surface.
 *
 * Everything exported here runs unchanged in Node and in the browser.
 * Node-only code (hashing, provenance chains) lives behind the
 * "@deadreckon/core/provenance" subpath so Vite never tries to shim
 * node:crypto into a bundle that ships to a phone.
 */
export * from './types.js';
export * from './geo.js';
export * from './deadreckon.js';
export * from './wire.js';
export * from './sources.js';
