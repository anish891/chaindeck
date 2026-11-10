// The paper app's live data: one WebSocket (the shared client in public/js/stream.js), opened once for the whole app.
// Components never open a socket and never poll; they read from the hooks here.
//
// The socket connects under /api/paper because the owner's session cookie is scoped to that path.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createStream } from '../../public/js/stream.js';
import type { Stream, StreamState } from '../../public/js/stream.js';
import type { OptionType } from './types';

let stream: Stream | null = null;
/** The app's stream, created on first use (after sign-in, so the cookie is there when the socket opens). */
export function live(): Stream {
  if (!stream) {
    stream = createStream({ path: '/api/paper/ws' });
    stream.on('ticks', onTicks);
  }
  return stream;
}

/** Close the socket (sign-out). The next live() opens a new one. */
export function closeLive(): void {
  if (stream) stream.close();
  stream = null;
  prices.clear();
}

/** Connection state for the status indicator: re-renders only when it changes. */
export function useConnection(): StreamState {
  const s = live();
  return useSyncExternalStore(s.subscribe, s.getState, s.getState);
}

// ── tick prices: one small store, read per cell ──────────────────────────────
// A tick message changes a handful of prices. Each price cell subscribes to its own key, so a tick re-renders only the
// cells that moved, never the table.

const prices = new Map<string, number>();
const cellListeners = new Map<string, Set<() => void>>();
let spot: number | null = null;
const spotListeners = new Set<() => void>();
let scope = ''; // `${symbol}|${expiry}` the stored prices belong to

const cellKey = (strike: number, type: OptionType) => `${strike}|${type}`;

function onTicks(msg: { symbol: string; expiry: string; spot: number | null; legs: [number, OptionType, number][] }): void {
  if (`${msg.symbol}|${msg.expiry}` !== scope) return; // for an expiry the page has left
  for (const [strike, type, ltp] of msg.legs) {
    if (!(ltp > 0)) continue;
    const key = cellKey(strike, type);
    if (prices.get(key) === ltp) continue;
    prices.set(key, ltp);
    const set = cellListeners.get(key);
    if (set) for (const fn of set) fn();
  }
  if (typeof msg.spot === 'number' && msg.spot > 0 && msg.spot !== spot) {
    spot = msg.spot;
    for (const fn of spotListeners) fn();
  }
}

/** Ask for one expiry's price changes. Prices held for another expiry are dropped. */
export function watchTicks(symbol: string, expiry: string | null): void {
  const next = expiry ? `${symbol}|${expiry}` : '';
  if (next === scope) return;
  scope = next;
  prices.clear();
  spot = null;
  if (expiry) live().watch({ type: 'ticks', symbol, expiry });
  else live().unwatch('ticks');
}

/** The latest price of one contract: the tick if there is one, else the snapshot value. Re-renders only this cell. */
export function useLivePrice(strike: number, type: OptionType, snapshot: number | null): number | null {
  const key = cellKey(strike, type);
  const tick = useSyncExternalStore(
    fn => {
      if (!cellListeners.has(key)) cellListeners.set(key, new Set());
      cellListeners.get(key)!.add(fn);
      return () => { cellListeners.get(key)?.delete(fn); };
    },
    () => prices.get(key) ?? null,
    () => null
  );
  return tick ?? snapshot;
}

export function useLiveSpot(snapshot: number | null): number | null {
  const tick = useSyncExternalStore(fn => { spotListeners.add(fn); return () => { spotListeners.delete(fn); }; }, () => spot, () => null);
  return tick ?? snapshot;
}

/** 'tick-up' / 'tick-down' for a moment after `value` rises or falls; '' otherwise (and on first render). */
export function useFlash(value: number | null): string {
  const prev = useRef<number | null>(value);
  const [flash, setFlash] = useState<{ cls: string; n: number }>({ cls: '', n: 0 });
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before === null || value === null || before === value) return;
    setFlash(f => ({ cls: value > before ? 'tick-up' : 'tick-down', n: f.n + 1 }));
  }, [value]);
  return flash.cls ? `${flash.cls} tick-${flash.n % 2}` : '';
}
