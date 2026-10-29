import { useCallback, useEffect, useState } from 'react';
import { api, setSignedOutHandler } from './api';
import { MARKET_REASONS, instrumentKey } from './format';
import { readPref, writePref, applyTheme, loadTheme, saveTheme } from './theme';
import type { Theme } from './theme';
import { Login } from './components/Login';
import { TopBar } from './components/TopBar';
import { Strip } from './components/Strip';
import { Chain } from './components/Chain';
import { Ticket } from './components/Ticket';
import { Blotter, BLOTTER_TABS } from './components/Blotter';
import type { BlotterTab } from './components/Blotter';
import { PayoffPanel, EquityPanel } from './components/ChartPanels';
import { AccountsPanel } from './components/AccountsPanel';
import { Perf } from './components/Perf';
import { Lab } from './lab/Lab';
import type { Selection } from './ticket';
import type { AccountDetail, AccountListItem, Market, OptionType, Session, Side } from './types';

type Boot = 'loading' | 'unreachable' | 'unconfigured' | 'signedOut' | 'ready';
type View = 'trade' | 'lab' | 'perf';

const OPEN_POLL_MS = 15000; // NSE refreshes about once a minute; faster polling only spends storage commands
const CLOSED_POLL_MS = 60000;

const savedView = (): View => { const v = readPref('paper_view'); return v === 'lab' || v === 'perf' ? v : 'trade'; };
const savedTab = (): BlotterTab => { const v = readPref('paper_tab'); return BLOTTER_TABS.some(([id]) => id === v) ? (v as BlotterTab) : 'positions'; };

export function App() {
  const [boot, setBoot] = useState<Boot>('loading');
  const [needsSecret, setNeedsSecret] = useState(false);
  const [theme, setTheme] = useState<Theme>(loadTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);
  const changeTheme = (t: Theme) => { saveTheme(t); setTheme(t); };

  const checkSession = useCallback(async () => {
    const s = await api<Session>('/session');
    if (!s.ok) { setBoot(s.status === 0 ? 'unreachable' : 'unreachable'); return; }
    setNeedsSecret(s.needsSecret);
    setBoot(!s.configured ? 'unconfigured' : s.signedIn ? 'ready' : 'signedOut');
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => setBoot('signedOut'));
    void checkSession();
    return () => setSignedOutHandler(null);
  }, [checkSession]);

  async function signOut() {
    await api('/session', { method: 'DELETE' });
    setBoot('signedOut');
  }

  if (boot === 'ready') return <Workspace theme={theme} onTheme={changeTheme} canSignOut={needsSecret} onSignOut={signOut} />;

  const status = boot === 'loading' ? 'Connecting…' : boot === 'unreachable' ? 'Cannot reach the server' : boot === 'unconfigured' ? 'Paper trading is not configured on this server' : 'Signed out';
  return (
    <>
      <TopBar statusText={status} statusOk={false} accounts={[]} accountId={null} onAccount={() => {}} signedIn={false} manageOpen={false} onManage={() => {}} canSignOut={false} onSignOut={() => {}} theme={theme} onTheme={changeTheme} />
      {boot === 'signedOut' && <Login onSignedIn={() => void checkSession()} />}
    </>
  );
}

interface WorkspaceProps {
  theme: Theme;
  onTheme: (t: Theme) => void;
  canSignOut: boolean;
  onSignOut: () => void;
}

function Workspace({ theme, onTheme, canSignOut, onSignOut }: WorkspaceProps) {
  const [accounts, setAccounts] = useState<AccountListItem[]>([]);
  const [accountId, setAccountId] = useState<string | null>(() => readPref('paper_account'));
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [market, setMarket] = useState<Market | null>(null);
  const [marketLoaded, setMarketLoaded] = useState(false);
  const [expiry, setExpiry] = useState<string | null>(null); // the user's choice; the server's current expiry is market.expiry
  const [view, setView] = useState<View>(savedView);
  const [visited, setVisited] = useState<Record<View, boolean>>(() => ({ trade: true, lab: savedView() === 'lab', perf: savedView() === 'perf' }));
  const [tab, setTab] = useState<BlotterTab>(savedTab);
  const [manage, setManage] = useState(false);
  const [selection, setSelection] = useState<Selection>({ instrument: null, side: 'BUY', nonce: 0 });
  const [reload, setReload] = useState(0);
  const bump = useCallback(() => setReload(n => n + 1), []);

  const loadAccounts = useCallback(async (selectId?: string) => {
    const r = await api<{ accounts: AccountListItem[] }>('/accounts');
    if (!r.ok) return;
    setAccounts(r.accounts);
    setAccountId(cur => {
      const next = selectId && r.accounts.some(a => a.id === selectId) ? selectId : r.accounts.some(a => a.id === cur) ? cur : r.accounts[0] ? r.accounts[0].id : null;
      if (next) writePref('paper_account', next);
      return next;
    });
    bump();
  }, [bump]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  // The data loop: market and account together, again after 15 s while trading and 60 s otherwise.
  useEffect(() => {
    if (!accountId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      const q = expiry ? `?expiry=${encodeURIComponent(expiry)}` : '';
      const [m, a] = await Promise.all([api<Market>(`/market${q}`), api<AccountDetail>(`/accounts/${encodeURIComponent(accountId)}`)]);
      if (cancelled) return;
      if (m.status === 401 || a.status === 401) return; // the signed-out handler is already showing the sign-in form
      setMarket(m.ok ? m : null);
      setMarketLoaded(true);
      if (a.ok) setAccount(a);
      timer = setTimeout(run, m.ok && m.marketOpen ? OPEN_POLL_MS : CLOSED_POLL_MS);
    };
    void run();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [accountId, expiry, reload]);

  useEffect(() => {
    const onVisible = () => { if (!document.hidden) bump(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [bump]);

  const chooseView = (v: View) => {
    setView(v);
    setVisited(x => ({ ...x, [v]: true }));
    writePref('paper_view', v);
  };
  const chooseTab = (t: BlotterTab) => { setTab(t); writePref('paper_tab', t); };
  const chooseAccount = (id: string) => {
    writePref('paper_account', id);
    setAccount(null);
    setSelection({ instrument: null, side: 'BUY', nonce: 0 });
    setAccountId(id);
  };
  const pick = (strike: number, type: OptionType, side: Side) => {
    if (!market || !market.expiry) return;
    setSelection(s => ({ instrument: instrumentKey(market.expiry as string, strike, type), side, nonce: s.nonce + 1 }));
  };

  const h = market && market.health;
  const statusText = !marketLoaded ? 'Connecting…' : !market ? 'No market data' : h && h.ok ? 'Trading open' : h && h.reason === 'MARKET_CLOSED' ? 'Market closed' : 'Trading paused';
  const showBanner = !!h && !h.ok && h.reason !== 'MARKET_CLOSED';
  const held = new Set(account ? account.summary.positions.map(p => p.instrument) : []);

  return (
    <>
      <TopBar
        statusText={statusText}
        statusOk={!!h && h.ok}
        accounts={accounts}
        accountId={accountId}
        onAccount={chooseAccount}
        signedIn
        manageOpen={manage}
        onManage={() => setManage(m => !m)}
        canSignOut={canSignOut}
        onSignOut={onSignOut}
        theme={theme}
        onTheme={onTheme}
      />
      <main>
        <Strip account={account} market={market} />
        {showBanner && <div className="pt-banner" role="status">{MARKET_REASONS[h!.reason || ''] || 'Trading is paused.'}</div>}

        {manage && <AccountsPanel accounts={accounts} accountId={accountId} account={account} onAccountsChanged={id => void loadAccounts(id)} onAccountChanged={bump} />}

        <div className="section pt-views">
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={`seg-btn${view === 'trade' ? ' active' : ''}`} onClick={() => chooseView('trade')}>Trade</button>
            <button type="button" className={`seg-btn${view === 'lab' ? ' active' : ''}`} onClick={() => chooseView('lab')}>Strategy lab</button>
            <button type="button" className={`seg-btn${view === 'perf' ? ' active' : ''}`} onClick={() => chooseView('perf')}>Performance</button>
          </div>
        </div>

        <div hidden={view !== 'trade'}>
          <div className="section pt-grid">
            <Chain market={market} held={held} selection={selection} onPick={pick} onExpiry={setExpiry} />
            <Ticket accountId={accountId} market={market} selection={selection} onSide={side => setSelection(s => ({ ...s, side }))} onPlaced={bump} />
          </div>
          <div className="section">
            <Blotter account={account} accountId={accountId} lotSize={(market && market.lotSize) || 65} tab={tab} onTab={chooseTab} onChanged={bump} />
          </div>
          <div className="section pt-grid pt-grid-even">
            <PayoffPanel account={account} market={market} />
            <EquityPanel account={account} />
          </div>
        </div>

        {visited.lab && <div hidden={view !== 'lab'}><Lab accounts={accounts} accountId={accountId} marketOpen={!!(market && market.marketOpen)} active={view === 'lab'} /></div>}
        {visited.perf && <div hidden={view !== 'perf'}><Perf accountId={accountId} active={view === 'perf'} /></div>}

        <div className="section pt-foot">
          <div className="panel-note">Paper trading with simulated money on real NSE prices. Fills, charges and margin are approximations of what a broker would do. For practice and testing only, not investment advice.</div>
        </div>
      </main>
    </>
  );
}
