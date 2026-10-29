import { dayTime, inr, pnlClass, todayIst } from '../format';
import type { AccountDetail, Market } from '../types';

function Item({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return <div className="ks-item"><span className="ks-label">{label}</span><span className={`ks-val ${cls}`.trim()}>{value}</span></div>;
}

/** Equity as of the last recorded close before today, or the starting capital on a new account. */
export function previousClose(account: AccountDetail, now = Date.now()): number {
  const today = todayIst(now);
  const prior = account.curve.filter(p => p.ymd < today);
  return prior.length ? prior[prior.length - 1]!.equity : account.summary.startingCapital;
}

export function Strip({ account, market }: { account: AccountDetail | null; market: Market | null }) {
  if (!account) return <div className="keystrip" />;
  const s = account.summary;
  const day = s.equity - previousClose(account);
  const total = s.equity - s.startingCapital;
  const stale = !!market && !market.health.ok && market.health.reason !== 'MARKET_CLOSED';
  return (
    <div className="keystrip">
      <Item label="Equity" value={inr(s.equity)} />
      <Item label="Today" value={inr(day, true)} cls={pnlClass(day)} />
      <Item label="Total P&L" value={`${inr(total, true)} (${((total / s.startingCapital) * 100).toFixed(2)}%)`} cls={pnlClass(total)} />
      <Item label="Unrealised" value={inr(s.unrealized, true)} cls={pnlClass(s.unrealized)} />
      <Item label="Realised" value={inr(s.realized, true)} cls={pnlClass(s.realized)} />
      <Item label="Charges" value={inr(s.charges)} />
      <Item label="Margin used" value={inr(s.margin)} />
      <Item label="Free cash" value={inr(s.available)} cls={s.available < 0 ? 'pt-neg' : ''} />
      <Item label="NIFTY" value={market && market.spot ? market.spot.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'n/a'} />
      <Item label="Prices as of" value={market && market.asOf ? dayTime(market.asOf) : 'n/a'} cls={stale ? 'stale' : ''} />
    </div>
  );
}
