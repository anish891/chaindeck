// Same theme setting as the dashboard (shared localStorage key), so both pages always agree.

export type Theme = 'system' | 'dark' | 'light';
const KEY = 'oi_tracker_theme';

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(theme: Theme): void {
  try { localStorage.setItem(KEY, theme); } catch { /* storage unavailable */ }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** Small persisted preference helpers (a blocked or full storage must never break the page). */
export function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writePref(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
