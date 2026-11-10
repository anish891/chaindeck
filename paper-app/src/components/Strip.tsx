import { dayTime, inr, pnlClass, todayIst } from '../format';
import { useFlash, useLiveSpot } from '../live';
import type { AccountDetail, Market } from '../types';

function Item({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return <div className="ks-item"><span className="ks-label">{label}</span><span className={`ks-val ${cls}`.trim()}>{value}</span></div>;
}

const LABELS = ['Today', 'Total P&L', 'Free cash', 'Index', 'Prices as of'];
/** Shown until the account has arrived: the strip's shape, with placeholders where the numbers will be. */
function StripSkeleton() {
  return (
    <div className="keystrip" aria-busy="true">
      {LABELS.map(l => <div className="ks-item" key={l}><span className="ks-label">{l}</span><span className="ks-val"><span className="skeleton" /></span></div>)}
    </div>
  );
}

/** Equity as of the last recorded close before today, or the starting capital on a new account. */
export function previousClose(account: AccountDetail, now = Date.now()): number {
  const today = todayIst(now);
  const prior = account.curve.filter(p => p.ymd < today);
  return prior.length ? prior[prior.length - 1]!.equity : account.summary.startingCapital;
}

export function Strip({ account, market }: { account: AccountDetail | null; market: Market | null }) {
  const sym = (account && account.summary.symbol) || 'NIFTY';
  const snapshotSpot = account ? (market && (market.symbol || 'NIFTY') === sym ? market.spot : account.summary.spot) : null;
  const spot = useLiveSpot(snapshotSpot || null); // moves with the ticks between market pushes
  const spotFlash = useFlash(spot);
  if (!account) return <StripSkeleton />;
  const s = account.summary;
  const day = s.equity - previousClose(account);
  const total = s.equity - s.startingCapital;
  const stale = !!market && !market.health.ok && market.health.reason !== 'MARKET_CLOSED';
  const symbol = s.symbol || 'NIFTY';
  return (
    <div className="keystrip">
      <Item label="Today" value={inr(day, true)} cls={pnlClass(day)} />
      <Item label="Total P&L" value={`${inr(total, true)} (${((total / s.startingCapital) * 100).toFixed(2)}%)`} cls={pnlClass(total)} />
      <Item label="Free cash" value={inr(s.available)} cls={s.available < 0 ? 'pt-neg' : ''} />
      <Item label={symbol} value={spot ? spot.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'n/a'} cls={spotFlash} />
      <Item label="Prices as of" value={market && market.asOf ? dayTime(market.asOf) : 'n/a'} cls={stale ? 'stale' : ''} />
    </div>
  );
}
