import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { dayTime } from '../format';
import { useConfirm } from '../hooks';
import { ConfirmButton } from './ConfirmButton';
import type { AccountDetail, AccountListItem, AgentKey } from '../types';

/** The text to paste to an AI agent: where the API is, how to authenticate, and the rules it must follow. */
export function agentPrompt(origin: string, token: string): string {
  const base = `${origin}/api/paper/v1`;
  return [
    'You can trade NIFTY options on my ChainDeck paper trading account. The money is simulated; the prices are real NSE prices.',
    `API base URL: ${base}`,
    `Send this header on every request: Authorization: Bearer ${token}`,
    `Start with GET ${base} for the rules, endpoints and order format, then GET ${base}/account and ${base}/context.`,
    'Every order must include a "reason" explaining why. Send an Idempotency-Key header with every POST /orders.',
    'Orders are only accepted 09:15 to 15:30 IST on trading days. If you get AGENTS_PAUSED, stop trading.'
  ].join('\n');
}

interface Props {
  accounts: AccountListItem[];
  accountId: string | null;
  account: AccountDetail | null;
  onAccountsChanged: (selectId?: string) => void;
  onAccountChanged: () => void;
}

export function AccountsPanel({ accounts, accountId, account, onAccountsChanged, onAccountChanged }: Props) {
  const confirm = useConfirm();
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newCap, setNewCap] = useState('100000');
  const [manageError, setManageError] = useState('');
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [keyLabel, setKeyLabel] = useState('');
  const [keyScope, setKeyScope] = useState<'trade' | 'read'>('trade');
  const [keyError, setKeyError] = useState('');
  const [fresh, setFresh] = useState<{ token: string; prompt: string } | null>(null);
  const [copied, setCopied] = useState('');
  const current = accounts.find(a => a.id === accountId);
  const paused = !!(account && account.agentsPaused);

  const loadKeys = useCallback(async () => {
    if (!accountId) return;
    const r = await api<{ keys: AgentKey[] }>(`/accounts/${encodeURIComponent(accountId)}/keys`);
    setKeys(r.ok ? r.keys : []);
  }, [accountId]);

  // a different account has different keys, and a key shown once belongs to the account it was made for
  useEffect(() => { setFresh(null); void loadKeys(); }, [loadKeys]);

  async function createAccount() {
    setManageError('');
    const r = await api<{ account: { id: string } }>('/accounts', { method: 'POST', body: { id: newId.trim(), name: newName.trim() || undefined, startingCapital: Number(newCap) } });
    if (!r.ok) { setManageError(r.error || 'Could not create the account.'); return; }
    setNewId(''); setNewName('');
    onAccountsChanged(r.account.id);
  }

  async function act(kind: 'reset' | 'delete', id: string) {
    const key = `${kind}|${id}`;
    if (!confirm.isArmed(key)) { confirm.arm(key); return; }
    confirm.clear();
    const r = kind === 'reset'
      ? await api(`/accounts/${encodeURIComponent(id)}/reset`, { method: 'POST' })
      : await api(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) setManageError(r.error || `${kind === 'reset' ? 'Reset' : 'Delete'} failed.`);
    onAccountsChanged();
  }

  async function createKey() {
    if (!accountId) return;
    setKeyError('');
    const r = await api<{ token: string }>(`/accounts/${encodeURIComponent(accountId)}/keys`, { method: 'POST', body: { label: keyLabel.trim(), scope: keyScope } });
    if (!r.ok) { setKeyError(r.error || 'Could not create the key.'); return; }
    setKeyLabel('');
    setFresh({ token: r.token, prompt: agentPrompt(window.location.origin, r.token) });
    await loadKeys();
  }

  async function revoke(keyId: string) {
    const key = `revoke|${keyId}`;
    if (!confirm.isArmed(key)) { confirm.arm(key); return; }
    confirm.clear();
    const r = await api(`/accounts/${encodeURIComponent(accountId!)}/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
    if (!r.ok) setKeyError(r.error || 'Could not revoke the key.');
    await loadKeys();
  }

  async function togglePause() {
    if (!account || !accountId) return;
    const r = await api<{ paused: boolean }>(`/accounts/${encodeURIComponent(accountId)}/agents`, { method: 'POST', body: { paused: !account.agentsPaused } });
    if (!r.ok) { setKeyError(r.error || 'Could not change the agent switch.'); return; }
    onAccountChanged();
  }

  async function copy(text: string, which: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      setKeyError('Copy failed. Select the text and copy it by hand.');
    }
  }

  const live = keys.filter(k => !k.revokedAt);
  const shown = [...live, ...keys.filter(k => k.revokedAt).slice(-3)];

  return (
    <div className="section">
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">Accounts</div>
          <span className="panel-note">Separate accounts keep strategies and AI agents apart. Each has its own cash and history.</span>
        </div>
        <div className="pt-account-list">
          {accounts.map(a => (
            <div className="pt-account-row" key={a.id}>
              <span><b>{a.name}</b> <span className="pt-muted">{a.id}{a.active ? ', has open positions or orders' : ''}</span></span>
              <span>
                <ConfirmButton armed={confirm.isArmed(`reset|${a.id}`)} label="Reset" confirmLabel="Confirm reset" onClick={() => act('reset', a.id)} />
                {accounts.length > 1 && <ConfirmButton armed={confirm.isArmed(`delete|${a.id}`)} label="Delete" confirmLabel="Confirm delete" onClick={() => act('delete', a.id)} />}
              </span>
            </div>
          ))}
        </div>
        <div className="pt-form-row">
          <input placeholder="id, e.g. scalping" maxLength={24} aria-label="New account id" value={newId} onChange={e => setNewId(e.target.value)} />
          <input placeholder="Name" maxLength={40} aria-label="New account name" value={newName} onChange={e => setNewName(e.target.value)} />
          <input type="number" min={10000} step={10000} aria-label="Starting capital" value={newCap} onChange={e => setNewCap(e.target.value)} />
          <button type="button" onClick={createAccount}>Create account</button>
        </div>
        <div className="pt-error" role="alert">{manageError}</div>

        <div className="panel-head subhead">
          <div className="panel-title">AI agents on <span>{current ? current.name : 'this account'}</span></div>
          <button type="button" className={paused ? 'pt-paused' : ''} onClick={togglePause}>{paused ? 'Agent trading: paused' : 'Agent trading: on'}</button>
        </div>
        <p className="pt-muted pt-gap">Give Claude or another AI a key for this account. It can only see and trade this account, every order must say why, and you can pause it or revoke the key at any time. Keys are shown once; only a fingerprint is stored.</p>
        <div className="pt-account-list">
          {shown.length ? shown.map(k => (
            <div className={`pt-account-row${k.revokedAt ? ' pt-revoked' : ''}`} key={k.keyId}>
              <span><b>{k.label}</b> <span className="pt-muted">cdp_{k.keyId}_..., {k.scope === 'trade' ? 'can trade' : 'read only'}, {k.revokedAt ? `revoked ${dayTime(k.revokedAt)}` : k.lastUsedAt ? `last used ${dayTime(k.lastUsedAt)}` : 'not used yet'}</span></span>
              <span>{!k.revokedAt && <ConfirmButton armed={confirm.isArmed(`revoke|${k.keyId}`)} label="Revoke" confirmLabel="Confirm revoke" onClick={() => revoke(k.keyId)} />}</span>
            </div>
          )) : <div className="empty-note">No agent keys for this account yet.</div>}
        </div>
        <div className="pt-form-row">
          <input placeholder="Key name, e.g. Claude" maxLength={40} aria-label="Key name" value={keyLabel} onChange={e => setKeyLabel(e.target.value)} />
          <select aria-label="Key permissions" value={keyScope} onChange={e => setKeyScope(e.target.value as 'trade' | 'read')}>
            <option value="trade">Can trade</option>
            <option value="read">Read only</option>
          </select>
          <button type="button" onClick={createKey}>Create key</button>
        </div>
        <div className="pt-error" role="alert">{keyError}</div>
        {fresh && (
          <div className="pt-newkey">
            <div className="pt-label">New key (copy it now, it will not be shown again)</div>
            <code>{fresh.token}</code>
            <div className="pt-label">Paste this to your AI agent</div>
            <pre>{fresh.prompt}</pre>
            <div className="pt-form-row">
              <button type="button" onClick={() => copy(fresh.token, 'key')}>{copied === 'key' ? 'Copied' : 'Copy key'}</button>
              <button type="button" onClick={() => copy(fresh.prompt, 'prompt')}>{copied === 'prompt' ? 'Copied' : 'Copy instructions'}</button>
              <button type="button" onClick={() => setFresh(null)}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
