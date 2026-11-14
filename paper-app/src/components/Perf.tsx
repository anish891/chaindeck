import { useEffect, useState } from 'react';
import { api } from '../api';
import { inr, pctText } from '../format';
import type { Analytics, Bucket, CompareRow, SetupRow } from '../types';

const cls = (x: number) => (x > 0 ? 'pt-pos' : x < 0 ? 'pt-neg' : '');

function Card({ label, value, sub, c = '' }: { label: string; value: string; sub: string; c?: string }) {
  return <div className="glance-card"><div className="glance-label">{label}</div><div className={`glance-big ${c}`.trim()}>{value}</div><div className="glance-line pt-muted">{sub}</div></div>;
}

function BucketTable({ rows, first, empty }: { rows: Bucket[]; first: string; empty: string }) {
  if (!rows.length) return <div className="empty-note">{empty}</div>;
  return (
    <table className="pt-table">
      <thead><tr><th>{first}</th><th className="right">Fills</th><th className="right">Closes</th><th className="right">Win rate</th><th className="right">Booked</th><th className="right">Charges</th><th className="right">Net</th></tr></thead>
      <tbody>
        {rows.map(b => (
          <tr key={b.label}>
            <td>{b.label}</td><td className="right">{b.fills}</td><td className="right">{b.closes}</td>
            <td className="right">{b.closes ? pctText(b.wins / b.closes) : 'n/a'}</td>
            <td className={`right ${cls(b.realized)}`}>{inr(b.realized, true)}</td><td className="right">{inr(b.charges)}</td>
            <td className={`right ${cls(b.net)}`}>{inr(b.net, true)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SAMPLE_TEXT: Record<SetupRow['sample'], string> = {
  few: 'Too few to judge',
  early: 'Early read',
  ok: 'Reasonable sample'
};

/**
 * Expectancy by setup: for each reason a trade was taken, how often it won, how much it won and lost on average, and
 * what one trade of it has been worth, all after charges. The sample column is there so that three lucky trades are not
 * read as an edge: under 30 closed trades the row is dimmed and says so, and the win rate always carries its range.
 */
export function SetupTable({ rows }: { rows: SetupRow[] }) {
  if (!rows.length) {
    return <div className="empty-note">No closed trades yet. Fill in "Setup" on the order ticket when you enter a trade (for example Breakout or Range fade) and each setup's results build up here.</div>;
  }
  return (
    <table className="pt-table pt-setups">
      <thead>
        <tr>
          <th>Setup</th><th className="right">Closed trades</th><th className="right">Win rate</th><th className="right">Avg win</th><th className="right">Avg loss</th>
          <th className="right" title="Average result of one closed trade, after charges: win rate x average win + loss rate x average loss">Expectancy / trade</th>
          <th className="right">Net</th><th>Sample</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.label} className={r.sample === 'few' ? 'pt-thin' : ''}>
            <td>{r.label}{r.open > 0 && <span className="pt-muted"> · {r.open} open</span>}</td>
            <td className="right">{r.trades}</td>
            <td className="right">{r.winRate === null ? 'n/a' : <>{pctText(r.winRate)} <span className="pt-muted">({pctText(r.winRateLow)} to {pctText(r.winRateHigh)})</span></>}</td>
            <td className="right pt-pos">{r.avgWin === null ? 'n/a' : inr(r.avgWin)}</td>
            <td className="right pt-neg">{r.avgLoss === null ? 'n/a' : inr(r.avgLoss)}</td>
            <td className={`right ${r.expectancy === null ? '' : cls(r.expectancy)}`}><b>{r.expectancy === null ? 'n/a' : inr(r.expectancy, true)}</b></td>
            <td className={`right ${cls(r.net)}`}>{r.trades ? inr(r.net, true) : 'n/a'}</td>
            <td><span className={`pt-sample pt-sample-${r.sample}`}>{r.trades ? SAMPLE_TEXT[r.sample] : 'Nothing closed yet'}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Perf({ accountId, active }: { accountId: string | null; active: boolean }) {
  const [compare, setCompare] = useState<CompareRow[] | null>(null);
  const [x, setX] = useState<Analytics | null>(null);

  useEffect(() => {
    if (!active) return undefined; // loads each time the view is opened, and when the account changes
    let cancelled = false;
    (async () => {
      const [cmp, an] = await Promise.all([
        api<{ accounts: CompareRow[] }>('/compare'),
        accountId ? api<{ analytics: Analytics }>(`/accounts/${encodeURIComponent(accountId)}/analytics`) : Promise.resolve(null)
      ]);
      if (cancelled) return;
      if (cmp.ok) setCompare(cmp.accounts);
      setX(an && an.ok ? an.analytics : null);
    })();
    return () => { cancelled = true; };
  }, [accountId, active]);

  return (
    <>
      <div className="section">
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">All accounts</div>
            <span className="panel-note">Equity at current prices. Return and drawdown are against each account's starting capital.</span>
          </div>
          <div className="table-scroll">
            {compare ? (
              <table className="pt-table">
                <thead><tr><th>Account</th><th>Traded by</th><th className="right">Equity</th><th className="right">Return</th><th className="right">Max drawdown</th><th className="right">Closes</th><th className="right">Win rate</th><th className="right">Profit factor</th><th className="right">Charges</th></tr></thead>
                <tbody>
                  {compare.map(a => (
                    <tr key={a.id} className={a.id === accountId ? 'pt-atm' : ''}>
                      <td><b>{a.name}</b></td><td className="pt-note">{a.traders.join(', ') || 'nobody yet'}</td>
                      <td className="right">{inr(a.equity)}</td><td className={`right ${cls(a.returnPct)}`}>{a.returnPct > 0 ? '+' : ''}{a.returnPct.toFixed(2)}%</td>
                      <td className="right">{a.maxDrawdownPct ? `-${a.maxDrawdownPct.toFixed(2)}%` : '0%'}</td>
                      <td className="right">{a.closes}</td><td className="right">{pctText(a.winRate)}</td>
                      <td className="right">{a.profitFactor === null ? 'n/a' : a.profitFactor.toFixed(2)}</td><td className="right">{inr(a.charges)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty-note">Loading…</div>}
          </div>
        </div>
      </div>
      <div className="section">
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">This account: <span>{x ? x.name : 'n/a'}</span></div>
            {x && (
              <span className="pt-form-row">
                <a className="pt-link" href={`/api/paper/accounts/${encodeURIComponent(x.id)}/export?kind=trades`} download>Trades CSV</a>
                <a className="pt-link" href={`/api/paper/accounts/${encodeURIComponent(x.id)}/export?kind=orders`} download>Orders CSV</a>
              </span>
            )}
          </div>
          {x ? (
            <>
              <div className="glance-grid lab-cards">
                <Card label="Return" value={`${x.returnPct > 0 ? '+' : ''}${x.returnPct.toFixed(2)}%`} sub={`equity ${inr(x.equity)} from ${inr(x.startingCapital)}`} c={x.returnPct > 0 ? 'bull' : x.returnPct < 0 ? 'bear' : ''} />
                <Card label="Max drawdown" value={inr(x.maxDrawdown ? -x.maxDrawdown : 0)} sub={`${x.maxDrawdownPct.toFixed(2)}% from the peak`} />
                <Card label="Win rate" value={pctText(x.winRate)} sub={`${x.closes} closing fills`} />
                <Card label="Profit factor" value={x.profitFactor === null ? 'n/a' : x.profitFactor.toFixed(2)} sub={`avg win ${x.avgWin === null ? 'n/a' : inr(x.avgWin)}, avg loss ${x.avgLoss === null ? 'n/a' : inr(x.avgLoss)}`} />
                <Card label="Charges" value={inr(x.charges)} sub={x.chargesPctOfGross === null ? 'nothing booked yet' : `${x.chargesPctOfGross.toFixed(0)}% of booked P&L`} />
                <Card label="Best day" value={x.bestDay ? inr(x.bestDay.change, true) : 'n/a'} sub={x.bestDay ? x.bestDay.ymd : `${x.tradingDays} days recorded`} c={x.bestDay && x.bestDay.change > 0 ? 'bull' : ''} />
                <Card label="Worst day" value={x.worstDay ? inr(x.worstDay.change, true) : 'n/a'} sub={x.worstDay ? x.worstDay.ymd : 'closing equity is recorded after 15:30'} c={x.worstDay && x.worstDay.change < 0 ? 'bear' : ''} />
                <Card label="Open P&L" value={inr(x.unrealized, true)} sub={`booked ${inr(x.realized, true)}`} c={x.unrealized > 0 ? 'bull' : x.unrealized < 0 ? 'bear' : ''} />
              </div>
              <div className="lab-section">By who traded</div>
              <div className="table-scroll"><BucketTable rows={x.byWho} first="Who" empty="Nothing yet." /></div>
              <div className="lab-section">Expectancy by setup</div>
              <div className="table-scroll"><SetupTable rows={x.bySetup || []} /></div>
              <div className="panel-note">
                A trade is credited to the setup that opened it, whatever closed it, and counted once it is fully closed. Orders of one setup opened in the same minute are one trade (a spread is one result). All figures are after charges.
                The range after the win rate is where the true rate plausibly lies given the number of trades (95% interval); with under 30 closed trades treat the row as a note, not a result.
              </div>
              <div className="panel-note">{['Win rate and averages count fills that closed (part of) a position; charges are counted on every fill.', x.historyNote].filter(Boolean).join(' ')}</div>
            </>
          ) : <div className="empty-note">Loading…</div>}
        </div>
      </div>
    </>
  );
}
