import { Icon, themeIcon } from './Icons';
import type { AccountListItem } from '../types';
import type { Theme } from '../theme';
import type { StreamState } from '../../../public/js/stream.js';
import { tickTime } from '../../../public/js/stream.js';

interface Props {
  statusText: string;
  statusOk: boolean;
  /** The live connection, once signed in. Absent on the sign-in screen. */
  conn?: StreamState;
  accounts: AccountListItem[];
  accountId: string | null;
  onAccount: (id: string) => void;
  signedIn: boolean;
  manageOpen: boolean;
  onManage: () => void;
  canSignOut: boolean;
  onSignOut: () => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
}

export function TopBar(p: Props) {
  // connected: green when trading is open, red when it is paused or closed; otherwise the connection's own colour
  const dot = !p.conn ? (p.statusOk ? 'conn-connected' : 'error') : p.conn.status === 'connected' ? (p.statusOk ? 'conn-connected' : 'error') : `conn-${p.conn.status}`;
  const tick = p.conn ? tickTime(p.conn.lastTickAt) : '';
  return (
    <div className="topbar">
      <a href="/" className="logo">Chain<span>Deck</span></a>
      <span className="pt-badge">Paper trading</span>
      <div className="conn" role="status" aria-live="polite">
        <div className={`live-dot ${dot}`} aria-hidden="true" />
        <div className="status-text" data-status={p.conn ? p.conn.status : undefined}>{p.statusText}</div>
        {tick && <div className="last-tick">Last tick {tick}</div>}
      </div>

      <div className="topbar-right">
        {p.signedIn && (
          <>
            <label className="interval-label" htmlFor="ptAccountSelect">Account</label>
            <select id="ptAccountSelect" value={p.accountId || ''} onChange={e => p.onAccount(e.target.value)} disabled={p.accounts.length < 2}>
              {p.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button type="button" onClick={p.onManage} aria-expanded={p.manageOpen}>Accounts</button>
          </>
        )}
        <button type="button" className="pt-link" onClick={() => window.location.assign('/')} title="Back to the options dashboard">
          <Icon name="dashboard" /> Dashboard
        </button>
        <label className="interval-label" htmlFor="themeSelect">Theme</label>
        <span className="theme-ico" aria-hidden="true"><Icon name={themeIcon(p.theme)} /></span>
        <select id="themeSelect" value={p.theme} onChange={e => p.onTheme(e.target.value as Theme)} title="Select Theme">
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
        {p.signedIn && p.canSignOut && <button type="button" onClick={p.onSignOut}>Sign out</button>}
      </div>
    </div>
  );
}
