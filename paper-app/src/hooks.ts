import { useCallback, useEffect, useRef, useState } from 'react';

/** Two-step confirm: the first click arms an action for 4 seconds, a second click within that time does it. */
export function useConfirm(ms = 4000): { isArmed: (key: string) => boolean; arm: (key: string) => void; clear: () => void } {
  const [armed, setArmed] = useState<{ key: string; until: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(null);
  }, []);
  const arm = useCallback((key: string) => {
    if (timer.current) clearTimeout(timer.current);
    setArmed({ key, until: Date.now() + ms });
    timer.current = setTimeout(() => setArmed(null), ms);
  }, [ms]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const isArmed = useCallback((key: string) => !!armed && armed.key === key && Date.now() < armed.until, [armed]);
  return { isArmed, arm, clear };
}

/** Width of an element, kept current as it resizes (for the SVG charts). */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
