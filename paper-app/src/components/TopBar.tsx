import { Icon, themeIcon } from './Icons';
import type { AccountListItem } from '../types';
import type { Theme } from '../theme';

interface Props {
  statusText: string;
  statusOk: boolean;
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
  return (
    <div className="topbar">
      <a href="/" className="logo">Chain<span>Deck</span></a>
      <span className="pt-badge">Paper trading</span>
      <div className={`live-dot${p.statusOk ? '' : ' error'}`} />
      <div className="status-text" role="status">{p.statusText}</div>

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
