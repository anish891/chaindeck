import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { usePoll, useConfirm } from '../hooks';
import { blankStrategy, cloneStrategy } from '../strategy';
import { StrategyEditor } from './StrategyEditor';
import { Report } from './Report';
import { Deployments } from './Deployments';
import type { AccountListItem, BacktestReport, Deployment, SavedStrategy, Strategy } from '../types';

interface Props {
  accounts: AccountListItem[];
  accountId: string | null;
  marketOpen: boolean;
  active: boolean;
}

interface Current { id: string | null; strategy: Strategy }

export function Lab({ accounts, accountId, marketOpen, active }: Props) {
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  const [presets, setPresets] = useState<Strategy[]>([]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [deployError, setDeployError] = useState('');
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deployAccount, setDeployAccount] = useState('');
  const [copied, setCopied] = useState(false);
  const confirm = useConfirm();

  const loadLists = useCallback(async () => {
    const r = await api<{ saved: SavedStrategy[]; presets: Strategy[] }>('/strategies');
    if (!r.ok) return;
    setSaved(r.saved);
    setPresets(r.presets);
    setCurrent(c => c || { id: null, strategy: cloneStrategy(r.presets[0] || blankStrategy()) });
  }, []);

  const loadDeployments = useCallback(async () => {
    const r = await api<{ deployments: Deployment[] }>('/deployments');
    if (r.ok) setDeployments(r.deployments);
  }, []);

  useEffect(() => { void loadLists(); }, [loadLists]);
  useEffect(() => { if (active) void loadDeployments(); }, [active, loadDeployments]); // fresh whenever the lab is opened
  usePoll(loadDeployments, 15000, marketOpen && active); // live positions move only while trading

  const busy = new Set(deployments.filter(d => d.status !== 'stopped').map(d => d.accountId));
  useEffect(() => {
    const free = accounts.find(a => !busy.has(a.id));
    if (free && (!deployAccount || busy.has(deployAccount) || !accounts.some(a => a.id === deployAccount))) setDeployAccount(free.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute when accounts or deployments change
  }, [accounts, deployments]);

  const open = (c: Current | null) => { setCurrent(c); setReport(null); setError(''); confirm.clear(); };
  const edit = (strategy: Strategy) => setCurrent(c => (c ? { ...c, strategy } : c));

  async function run() {
    if (!current || running) return;
    setRunning(true);
    setError('');
    const r = await api<{ report: BacktestReport }>('/backtest', { method: 'POST', body: { strategy: current.strategy, accountId: accountId || undefined } });
    setRunning(false);
    if (!r.ok) { setError(r.error || 'Backtest failed.'); return; }
    setReport(r.report);
  }

  async function persist(asNew: boolean) {
    if (!current) return;
    setError('');
    const update = !asNew && current.id;
    const r = await api<{ saved: SavedStrategy }>(update ? `/strategies/${encodeURIComponent(current.id!)}` : '/strategies', { method: update ? 'PUT' : 'POST', body: { strategy: current.strategy } });
    if (!r.ok) { setError(r.error || 'Could not save.'); return; }
    setCurrent({ id: r.saved.id, strategy: cloneStrategy(r.saved.strategy) });
    await loadLists();
  }

  async function remove() {
    if (!current || !current.id) return;
    if (!confirm.isArmed('delete')) { confirm.arm('delete'); return; }
    confirm.clear();
    const r = await api(`/strategies/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
    if (!r.ok) { setError(r.error || 'Could not delete.'); return; }
    setCurrent(null);
    setReport(null);
    await loadLists();
    setCurrent({ id: null, strategy: blankStrategy() });
  }

  async function copyJson() {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(current.strategy, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy failed.');
    }
  }

  async function deploy() {
    if (!current || !current.id) return;
    setDeployError('');
    const r = await api('/deployments', { method: 'POST', body: { strategyId: current.id, accountId: deployAccount } });
    if (!r.ok) { setError(r.error || 'Could not deploy.'); return; }
    await loadDeployments();
  }

  async function setStatus(id: string, status: 'active' | 'paused' | 'stopped') {
    const r = await api(`/deployments/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status } });
    if (!r.ok) setDeployError(r.error || 'Could not change it.');
    await loadDeployments();
  }

  async function removeDeployment(id: string) {
    const r = await api(`/deployments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) setDeployError(r.error || 'Could not delete it.');
    await loadDeployments();
  }

  const item = (label: string, active: boolean, onClick: () => void, note = '', id = label) => (
    <button type="button" key={id} className={`lab-item${active ? ' active' : ''}`} onClick={onClick}>{label}{note && <> <span className="pt-muted">{note}</span></>}</button>
  );

  return (
    <>
      <div className="section pt-lab-grid">
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Strategies</div></div>
          <div className="lab-list">
            <div className="pt-label">Saved</div>
            {saved.length ? saved.map(r => item(r.strategy.name, !!current && current.id === r.id, () => open({ id: r.id, strategy: cloneStrategy(r.strategy) }), r.strategy.interval, r.id)) : <div className="empty-note">Nothing saved yet.</div>}
            <div className="pt-label lab-gap">Presets</div>
            {presets.map((p, i) => item(p.name, false, () => open({ id: null, strategy: cloneStrategy(p) }), p.interval, `preset-${i}`))}
            <button type="button" className="lab-item lab-new" onClick={() => open({ id: null, strategy: blankStrategy() })}>New blank strategy</button>
          </div>
        </div>

        <div className="panel lab-editor">
          <div className="panel-head">
            <div className="panel-title">Rules</div>
            <span className="panel-note">Judged on each candle's close, entered at the next candle's open, closed the same day.</span>
          </div>
          {current ? <StrategyEditor strategy={current.strategy} onChange={edit} error={error} onError={setError} /> : <div className="empty-note">Loading…</div>}
          <div className="pt-form-row">
            <button type="button" className="pt-primary" onClick={run} disabled={running || !current}>{running ? 'Running…' : 'Run backtest'}</button>
            <button type="button" onClick={() => persist(false)} disabled={!current}>{current && current.id ? 'Save' : 'Save strategy'}</button>
            {current && current.id && <button type="button" onClick={() => persist(true)}>Save as new</button>}
            <button type="button" onClick={copyJson} disabled={!current}>{copied ? 'Copied' : 'Copy as JSON'}</button>
            {current && current.id && <button type="button" className={confirm.isArmed('delete') ? 'pt-armed' : ''} onClick={remove}>{confirm.isArmed('delete') ? 'Confirm delete' : 'Delete'}</button>}
          </div>
          {current && current.id && (
            <div className="lab-deploy">
              <div className="pt-label">Run it live on a paper account: real NSE prices, checked every minute by the paper cron job</div>
              <div className="pt-form-row">
                <select aria-label="Account to run the strategy on" value={deployAccount} onChange={e => setDeployAccount(e.target.value)}>
                  {accounts.map(a => <option key={a.id} value={a.id} disabled={busy.has(a.id)}>{a.name}{busy.has(a.id) ? ' (strategy running)' : ''}</option>)}
                </select>
                <button type="button" onClick={deploy} disabled={!deployAccount || busy.has(deployAccount)}>Deploy</button>
              </div>
              <div className="pt-muted">One strategy per account keeps results apart: create a fresh account under Accounts first.</div>
            </div>
          )}
        </div>
      </div>

      {report && <Report r={report} />}
      <Deployments deployments={deployments} error={deployError} onStatus={setStatus} onDelete={removeDeployment} />
    </>
  );
}
