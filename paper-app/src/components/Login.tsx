import { useState } from 'react';
import { api } from '../api';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!secret || busy) return;
    setBusy(true);
    setError('');
    const r = await api('/session', { method: 'POST', body: { secret } });
    setBusy(false);
    if (!r.ok) { setError(r.error || 'Sign in failed.'); return; }
    setSecret('');
    onSignedIn();
  }

  return (
    <main className="pt-login">
      <form className="panel pt-login-card" onSubmit={submit}>
        <div className="panel-title">Paper trading</div>
        <p className="pt-muted">This page is for the owner only. Enter the paper trading secret to continue.</p>
        <input type="password" autoComplete="current-password" placeholder="Secret" aria-label="Paper trading secret" value={secret} onChange={e => setSecret(e.target.value)} autoFocus />
        <button type="submit" className="pt-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="pt-error" role="alert">{error}</div>
      </form>
    </main>
  );
}
