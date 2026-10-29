import { useMemo, useState } from 'react';
import { expiryCloseMs, inr, inrWhole, todayIst } from '../format';
import { payoffSeries } from '../payoff';
import type { PayoffLeg } from '../payoff';
import { quoteFor } from '../ticket';
import { LineChart } from './LineChart';
import type { AccountDetail, Market } from '../types';

export function PayoffPanel({ account, market }: { account: AccountDetail | null; market: Market | null }) {
  const positions = account ? account.summary.positions : [];
  const expiries = useMemo(() => [...new Set(positions.map(p => p.expiry))], [positions]);
  const [chosen, setChosen] = useState('');
  const exp = expiries.includes(chosen) ? chosen : expiries[0] || '';
  const spot = (market && market.spot) || (account && account.summary.spot) || 0;

  const series = useMemo(() => {
    if (!exp) return null;
    const legs: PayoffLeg[] = positions.filter(p => p.expiry === exp).map(p => {
      const q = market && market.expiry === p.expiry ? quoteFor(market, p.instrument) : null;
      return { strike: p.strike, optionType: p.optionType, qty: p.qty, avgPrice: p.avgPrice, iv: q && q.iv ? q.iv : null };
    });
    return payoffSeries(legs, { spot, expiryMs: expiryCloseMs(exp), nowMs: Date.now() });
  }, [positions, exp, market, spot]);

  const note = !series ? 'Open a position to see its payoff.' : (() => {
    const bits = [
      series.breakevens.length ? `Breakeven ${series.breakevens.join(', ')}` : 'No breakeven in this range',
      `max profit ${series.maxProfit === null ? 'unlimited' : inr(series.maxProfit)}`,
      `max loss ${series.maxLoss === null ? 'unlimited' : inr(series.maxLoss)}`
    ];
    return `${bits.join(', ')}. Today line uses each leg's IV from the chain; at expiry ignores charges.`;
  })();

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Payoff</div>
        {expiries.length > 1 && (
          <select aria-label="Expiry for the payoff chart" value={exp} onChange={e => setChosen(e.target.value)}>
            {expiries.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        )}
      </div>
      {series ? (
        <LineChart
          label="Profit and loss at expiry and today, across NIFTY levels"
          xs={series.xs}
          series={[
            { label: 'At expiry', values: series.atExpiry, color: 'var(--accent)', splitAtZero: true },
            { label: 'Today', values: series.today, color: 'var(--warn)', dashed: true, width: 1.5 }
          ]}
          yFormat={inrWhole}
          xFormat={x => `NIFTY ${x}`}
          zeroLine
        />
      ) : <div className="pt-chart" />}
      <div className="panel-note">{note}</div>
    </div>
  );
}

export function EquityPanel({ account }: { account: AccountDetail | null }) {
  const pts = useMemo(() => {
    if (!account) return [];
    const today = todayIst();
    const out = account.curve.filter(p => p.ymd !== today).map(p => ({ x: p.ymd, y: p.equity }));
    out.push({ x: 'Now', y: account.summary.equity });
    if (out.length === 1) out.unshift({ x: 'Start', y: account.summary.startingCapital });
    return out;
  }, [account]);
  const up = account ? pts[pts.length - 1]!.y >= account.summary.startingCapital : true;
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Equity</div>
        <span className="panel-note">Closing equity each trading day, plus now</span>
      </div>
      {account && pts.length ? (
        <LineChart label="Account equity over time" xs={pts.map(p => p.x)} series={[{ label: 'Equity', values: pts.map(p => p.y), color: up ? 'var(--bull)' : 'var(--bear)' }]} yFormat={inrWhole} dots />
      ) : <div className="pt-chart" />}
    </div>
  );
}
