import { useState } from 'react';
import { api } from '../api';
import { byText, dayTime, inr, instLabel, pnlClass, px, statusText, timeIst } from '../format';
import { useConfirm } from '../hooks';
import { ConfirmButton } from './ConfirmButton';
import type { AccountDetail } from '../types';

export type BlotterTab = 'positions' | 'orders' | 'trades';
export const BLOTTER_TABS: [BlotterTab, string][] = [['positions', 'Positions'], ['orders', 'Orders'], ['trades', 'Trades']];

interface Props {
  account: AccountDetail | null;
  accountId: string | null;
  lotSize: number;
  tab: BlotterTab;
  onTab: (t: BlotterTab) => void;
  onChanged: () => void;
}

const Empty = ({ text }: { text: string }) => <div className="empty-note">{text}</div>;

export function Blotter({ account, accountId, lotSize, tab, onTab, onChanged }: Props) {
  const [error, setError] = useState('');
  const confirm = useConfirm();
  const s = account && account.summary;

  async function exitPosition(instrument: string, qty: number) {
    const key = `exit|${instrument}`;
    if (!confirm.isArmed(key)) { confirm.arm(key); return; }
    confirm.clear();
    setError('');
    const r = await api(`/accounts/${encodeURIComponent(accountId!)}/orders`, {
      method: 'POST',
      body: { instrument, side: qty > 0 ? 'SELL' : 'BUY', lots: Math.abs(qty) / lotSize, orderType: 'MARKET', reason: 'Exit from positions' }
    });
    if (!r.ok) setError(r.error || 'Exit refused.');
    onChanged();
  }

  async function cancelOrder(id: string) {
    setError('');
    const r = await api(`/accounts/${encodeURIComponent(accountId!)}/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) setError(r.error || 'Cancel failed.');
    onChanged();
  }

  function body() {
    if (!account || !s) return <Empty text="Loading…" />;
    if (tab === 'positions') {
      if (!s.positions.length) return <Empty text="No open positions." />;
      return (
        <>
        <div className="pt-total">Total P&amp;L <b className={pnlClass(s.unrealized)}>{inr(s.unrealized, true)}</b></div>
        <table className="pt-table">
          <thead><tr><th>Contract</th><th className="right">Lots (qty)</th><th className="right">Avg</th><th className="right">LTP</th><th className="right">P&amp;L</th><th /></tr></thead>
          <tbody>
            {s.positions.map(p => (
              <tr key={p.instrument}>
                <td>{instLabel(p.instrument)}</td>
                <td className={`right ${p.qty > 0 ? 'pt-pos' : 'pt-neg'}`}>{p.qty > 0 ? '+' : ''}{p.qty / lotSize} ({p.qty})</td>
                <td className="right">{px(p.avgPrice)}</td>
                <td className="right">{px(p.mark)}</td>
                <td className={`right ${pnlClass(p.unrealized)}`}>{inr(p.unrealized, true)}</td>
                <td className="right"><ConfirmButton armed={confirm.isArmed(`exit|${p.instrument}`)} label="Exit" confirmLabel="Confirm exit" onClick={() => exitPosition(p.instrument, p.qty)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
      );
    }
    if (tab === 'orders') {
      return (
        <>
          {s.openOrders.length > 0 && <div className="pt-total">Waiting to fill</div>}
          {s.openOrders.length > 0 && openOrders()}
          {account.orders.length > 0 && <div className="pt-total">History</div>}
          {account.orders.length ? history() : s.openOrders.length ? null : <Empty text="No orders yet." />}
        </>
      );
    }
    return trades();
  }

  function openOrders() {
    const s = account!.summary;
    {
      return (
        <table className="pt-table">
          <thead><tr><th>Placed</th><th>Order</th><th>Contract</th><th>Side</th><th className="right">Lots</th><th>Type</th><th className="right">Limit</th><th className="right">Trigger</th><th>Status</th><th /></tr></thead>
          <tbody>
            {s.openOrders.map(o => (
              <tr key={o.id}>
                <td>{timeIst(o.placedAt)}</td>
                <td>{o.id}{o.parentId && <> <span className="pt-muted">exit of {o.parentId}</span></>}</td>
                <td>{instLabel(o.instrument)}</td>
                <td className={o.side === 'BUY' ? 'pt-pos' : 'pt-neg'}>{o.side}</td>
                <td className="right">{o.lots}</td><td>{o.orderType}</td>
                <td className="right">{px(o.limitPrice)}</td><td className="right">{px(o.triggerPrice)}</td>
                <td>{statusText(o)}</td>
                <td className="right"><button type="button" className="pt-small" onClick={() => cancelOrder(o.id)}>Cancel</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
  }

  function history() {
    {
      return (
        <table className="pt-table">
          <thead><tr><th>Placed</th><th>Order</th><th>Contract</th><th>Side</th><th className="right">Lots</th><th>Type</th><th className="right">Price</th><th className="right">Filled at</th><th>Status</th><th>By</th><th>Note</th></tr></thead>
          <tbody>
            {account!.orders.map(o => (
              <tr key={o.id}>
                <td>{dayTime(o.placedAt)}</td><td>{o.id}</td><td>{instLabel(o.instrument)}</td>
                <td className={o.side === 'BUY' ? 'pt-pos' : 'pt-neg'}>{o.side}</td><td className="right">{o.lots}</td><td>{o.orderType}</td>
                <td className="right">{px(o.limitPrice || o.triggerPrice)}</td><td className="right">{px(o.fillPrice)}</td>
                <td>{statusText(o)}</td><td>{byText(o)}</td><td className="pt-note">{o.reason || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
  }

  function trades() {
    if (!account!.trades.length) return <Empty text="No trades yet." />;
    return (
      <table className="pt-table">
        <thead><tr><th>Time</th><th>Contract</th><th>Side</th><th className="right">Qty</th><th className="right">Price</th><th className="right">Charges</th><th className="right">Booked P&amp;L</th><th>Kind</th></tr></thead>
        <tbody>
          {account!.trades.map((t, i) => (
            <tr key={`${t.at}-${i}`}>
              <td>{dayTime(t.at)}</td><td>{instLabel(t.instrument)}</td><td className={t.side === 'BUY' ? 'pt-pos' : 'pt-neg'}>{t.side}</td>
              <td className="right">{t.qty}</td><td className="right">{t.price.toFixed(2)}</td><td className="right">{inr(t.charges)}</td>
              <td className={`right ${pnlClass(t.realized)}`}>{t.realized ? inr(t.realized, true) : ''}</td>
              <td>{t.kind === 'settlement' ? 'expiry settlement' : 'fill'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="seg" role="group" aria-label="Blotter">
          {BLOTTER_TABS.map(([id, label]) => <button type="button" key={id} className={`seg-btn${tab === id ? ' active' : ''}`} onClick={() => onTab(id)}>{label}</button>)}
        </div>
      </div>
      {error && <div className="pt-error" role="alert">{error}</div>}
      <div className="table-scroll">{body()}</div>
    </div>
  );
}
