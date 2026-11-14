import { useCallback, useEffect, useState } from 'react';
import { api, setSignedOutHandler } from './api';
import { INDEX_INFO, MARKET_REASONS, inr, instrumentKey } from './format';
import { readPref, writePref, applyTheme, loadTheme, saveTheme } from './theme';
import type { Theme } from './theme';
import { Login } from './components/Login';
import { TopBar } from './components/TopBar';
import { Strip } from './components/Strip';
import { Chain } from './components/Chain';
import { OrderSheet } from './components/OrderSheet';
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

const OPEN_POLL_MS = 15000; // orders are checked about once a minute; faster polling only spends storage commands
const CLOSED_POLL_MS = 60000;

const savedView = (): View => { const v = readPref('paper_view'); return v === 'lab' || v === 'perf' ? v : 'trade'; };
const savedTab = (): BlotterTab => { const v = readPref('paper_tab'); return BLOTTER_TABS.some(([id]) => id === v) ? (v as BlotterTab) : 'positions'; };
const NOTICE_MS = 6000;
const VIEW_KEYS: Record<string, View> = { '1': 'trade', '2': 'lab', '3': 'perf' };
const SHORTCUTS: [string, string][] = [
  ['1  2  3', 'Trade, Strategy lab, Performance'],
  ['A', 'Open or close Accounts'],
  ['B  S', 'Buy or Sell, while an order ticket is open'],
  ['Esc', 'Close the order ticket'],
  ['?', 'Show or hide this list']
];
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

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

  // Ends every session issued so far, on every device, this one included (a cookie copied elsewhere stops working too).
  async function signOutEverywhere(): Promise<string | null> {
    const r = await api('/session/revoke-all', { method: 'POST' });
    if (!r.ok) return r.error || 'Could not sign out everywhere.';
    setBoot('signedOut');
    return null;
  }

  if (boot === 'ready') return <Workspace theme={theme} onTheme={changeTheme} canSignOut={needsSecret} onSignOut={signOut} onSignOutEverywhere={signOutEverywhere} />;

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
  onSignOutEverywhere: () => Promise<string | null>;
}

function Workspace({ theme, onTheme, canSignOut, onSignOut, onSignOutEverywhere }: WorkspaceProps) {
  const [keysOpen, setKeysOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountListItem[]>([]);
  const [accountId, setAccountId] = useState<string | null>(() => readPref('paper_account'));
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [loadedMarket, setMarket] = useState<Market | null>(null);
  const [marketLoaded, setMarketLoaded] = useState(false);
  const [expiry, setExpiry] = useState<string | null>(null); // the user's choice; the server's current expiry is market.expiry
  const [view, setView] = useState<View>(savedView);
  const [visited, setVisited] = useState<Record<View, boolean>>(() => ({ trade: true, lab: savedView() === 'lab', perf: savedView() === 'perf' }));
  const [tab, setTab] = useState<BlotterTab>(savedTab);
  const [manage, setManage] = useState(false);
  const [selection, setSelection] = useState<Selection>({ instrument: null, side: 'BUY', nonce: 0 });
  const [notice, setNotice] = useState('');
  const [payoff, setPayoff] = useState(false);
  const [reload, setReload] = useState(0);
  const bump = useCallback(() => setReload(n => n + 1), []);
  // each account trades one index; the order ticket's chain follows it
  const symbolOf = (id: string | null) => { const a = accounts.find(x => x.id === id); return (a && a.symbol) || 'NIFTY'; };
  const symbol = symbolOf(accountId);
  // a market loaded for the other index (just after switching accounts) is never shown or traded on
  const market = loadedMarket && (loadedMarket.symbol || 'NIFTY') === symbol ? loadedMarket : null;

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
      const params = [expiry ? `expiry=${encodeURIComponent(expiry)}` : '', symbol !== 'NIFTY' ? `symbol=${symbol}` : ''].filter(Boolean);
      const q = params.length ? `?${params.join('&')}` : '';
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
  }, [accountId, expiry, reload, symbol]);

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

  // Keyboard shortcuts. Never while typing in a field, never with a modifier (so browser shortcuts keep working), and
  // the view keys stay out of the way while an order ticket is open.
  const ticketOpen = !!selection.instrument;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (e.key === '?') { setKeysOpen(o => !o); return; }
      if (e.key === 'Escape') { setKeysOpen(false); return; }
      if (ticketOpen) return;
      const v = VIEW_KEYS[e.key];
      if (v) { setView(v); setVisited(x => ({ ...x, [v]: true })); writePref('paper_view', v); }
      else if (e.key.toLowerCase() === 'a') setManage(m => !m);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ticketOpen]);
  const chooseAccount = (id: string) => {
    writePref('paper_account', id);
    setAccount(null);
    setSelection({ instrument: null, side: 'BUY', nonce: 0 });
    if (symbolOf(id) !== symbol) setExpiry(null); // the other index has other expiries
    setAccountId(id);
  };
  const pick = (strike: number, type: OptionType, side: Side) => {
    if (!market || !market.expiry) return;
    setSelection(s => ({ instrument: instrumentKey(market.expiry as string, strike, type, market.symbol || 'NIFTY'), side, nonce: s.nonce + 1 }));
  };

  const h = market && market.health;
  const statusText = !marketLoaded ? 'Connecting…' : !market ? 'No market data' : h && h.ok ? 'Trading open' : h && h.reason === 'MARKET_CLOSED' ? 'Market closed' : 'Trading paused';
  const showBanner = !!h && !h.ok && h.reason !== 'MARKET_CLOSED';
  const closeSheet = useCallback(() => setSelection(s => ({ ...s, instrument: null })), []);
  const chooseSide = useCallback((side: Side) => setSelection(s => ({ ...s, side })), []);
  const placed = (text: string) => { closeSheet(); setNotice(text); bump(); };
  useEffect(() => {
    if (!notice) return undefined;
    const id = setTimeout(() => setNotice(''), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);
  const held = new Set(account ? account.summary.positions.map(p => p.instrument) : []);
  // setups already used on this account (your own tags, not strategy names), most recent first, for the ticket's suggestions
  const setups = account ? [...new Set(account.orders.filter(o => o.tag && o.source !== 'strategy').map(o => o.tag as string))].slice(0, 20) : [];

  return (
    <>
      <TopBar
        statusText={statusText}
        statusOk={!!h && h.ok}
        closed={!!h && h.reason === 'MARKET_CLOSED'}
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

        {account && account.risk && account.risk.breached && (
          <div className="pt-banner" role="status" data-kind="loss-limit">
            Daily loss limit reached: this account is down {inr(Math.abs(account.risk.dayPnl))} today against a limit of {inr(account.risk.maxDailyLoss)}. New positions are refused until the next session; you can still exit what you hold.
          </div>
        )}

        {manage && <AccountsPanel accounts={accounts} accountId={accountId} account={account} onAccountsChanged={id => void loadAccounts(id)} onAccountChanged={bump} onSignOutEverywhere={canSignOut ? onSignOutEverywhere : undefined} />}

        <div className="section pt-views">
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={`seg-btn${view === 'trade' ? ' active' : ''}`} aria-pressed={view === 'trade'} onClick={() => chooseView('trade')}>Trade</button>
            <button type="button" className={`seg-btn${view === 'lab' ? ' active' : ''}`} aria-pressed={view === 'lab'} onClick={() => chooseView('lab')}>Strategy lab</button>
            <button type="button" className={`seg-btn${view === 'perf' ? ' active' : ''}`} aria-pressed={view === 'perf'} onClick={() => chooseView('perf')}>Performance</button>
          </div>
          <button type="button" className="pt-small pt-keys-btn" aria-expanded={keysOpen} aria-controls="ptKeys" onClick={() => setKeysOpen(o => !o)} title="Keyboard shortcuts (?)">Shortcuts</button>
          {keysOpen && (
            <dl className="pt-keys" id="ptKeys">
              {SHORTCUTS.map(([k, what]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>)}
            </dl>
          )}
        </div>

        <div hidden={view !== 'trade'}>
          {notice && <div className="pt-toast" role="status">{notice}</div>}
          <div className="section">
            <Chain market={market} held={held} onPick={pick} onExpiry={setExpiry} />
          </div>
          <div className="section">
            <Blotter account={account} accountId={accountId} lotSize={(account && account.summary.lotSize) || (market && (market.symbol || 'NIFTY') === symbol && market.lotSize) || INDEX_INFO[symbol].lotSize} tab={tab} onTab={chooseTab} onChanged={bump} />
          </div>
          {tab === 'positions' && account && account.summary.positions.length > 0 && (
            <div className="section">
              <button type="button" className="pt-more" aria-expanded={payoff} onClick={() => setPayoff(p => !p)}>{payoff ? 'Hide payoff graph' : 'Show payoff graph'}</button>
              {payoff && <PayoffPanel account={account} market={market} />}
            </div>
          )}
          <OrderSheet accountId={accountId} market={market} selection={selection} setups={setups} equity={account ? account.summary.equity : null} onSide={chooseSide} onClose={closeSheet} onPlaced={placed} />
        </div>

        {visited.lab && <div hidden={view !== 'lab'}><Lab accounts={accounts} accountId={accountId} marketOpen={!!(market && market.marketOpen)} active={view === 'lab'} /></div>}
        {visited.perf && <div hidden={view !== 'perf'}><div className="section"><EquityPanel account={account} /></div><Perf accountId={accountId} active={view === 'perf'} /></div>}

        <div className="section pt-foot">
          <div className="panel-note">Paper trading with simulated money on real market prices from Upstox. Fills, charges and margin are approximations of what a broker would do. For practice and testing only, not investment advice.</div>
        </div>
      </main>
    </>
  );
}
