import { inr, inrWhole, pct, timeIst } from '../format';
import { VERDICT_TEXT } from '../strategy';
import { LineChart } from '../components/LineChart';
import type { BacktestReport } from '../types';

function Card({ label, value, sub, cls = '' }: { label: string; value: string | number; sub?: string; cls?: string }) {
  return <div className="glance-card"><div className="glance-label">{label}</div><div className={`glance-big ${cls}`.trim()}>{value}</div><div className="glance-line pt-muted">{sub}</div></div>;
}

export function Report({ r }: { r: BacktestReport }) {
  const [title, cls, explain] = VERDICT_TEXT[r.verdict] || VERDICT_TEXT.none!;
  const ci = r.expectancyCi ? `95%: ${inr(r.expectancyCi.low, true)} to ${inr(r.expectancyCi.high, true)}` : '';
  const base = r.baseline
    ? `Random entries with the same legs and exits averaged ${inr(r.baseline.expectancy, true)} a trade; this strategy beat ${r.baseline.percentile}% of ${r.baseline.runs} such runs.`
    : r.strategy.entry.conditions.length ? 'No baseline (no trades).' : 'No baseline: with no entry conditions the strategy already is the time-only version.';
  const pts = [{ x: 'Start', y: r.capital }, ...r.curve.map(p => ({ x: p.day, y: p.equity }))];
  const sign = (x: number) => (x > 0 ? 'bull' : x < 0 ? 'bear' : '');
  return (
    <div className="section">
      <div className="panel">
        <div className="panel-head"><div className="panel-title">Backtest</div></div>
        <div className="lab-verdict-row"><span className={`lab-verdict ${cls}`}>{title}</span> <span className="pt-muted">{explain}</span></div>
        <div className="glance-grid lab-cards">
          <Card label="Trades" value={r.trades} sub={`${r.data.sessions} sessions, ${r.data.from || ''} to ${r.data.to || ''}`} />
          <Card label="Win rate" value={pct(r.winRate)} sub={`95%: ${pct(r.winRateCi.low)} to ${pct(r.winRateCi.high)}`} />
          <Card label="Average trade" value={inr(r.expectancy, true)} sub={ci} cls={sign(r.expectancy)} />
          <Card label="Total after charges" value={inr(r.totalNet, true)} sub={`charges ${inr(r.totalCharges)}`} cls={sign(r.totalNet)} />
          <Card label="Max drawdown" value={inr(-r.maxDrawdown)} sub={`worst trade ${inr(r.worst, true)}`} />
          <Card label="Profit factor" value={r.profitFactor === null ? 'n/a' : r.profitFactor.toFixed(2)} sub={`avg win ${inr(r.avgWin)}, avg loss ${inr(r.avgLoss)}`} />
          <Card label="Capital needed" value={inr(r.capitalNeeded)} sub={r.fitsCapital ? `fits ${inr(r.capital)}` : `more than the account's ${inr(r.capital)}`} cls={r.fitsCapital ? '' : 'bear'} />
          <Card label="Exits" value={Object.entries(r.exits).map(([k, v]) => `${v} ${k}`).join(', ') || 'n/a'} sub={`average hold ${r.avgMinutes} min`} />
        </div>
        <div className="panel-note">{base}</div>
        <LineChart label="Backtest equity curve" xs={pts.map(p => p.x)} series={[{ label: 'Equity', values: pts.map(p => p.y), color: r.totalNet >= 0 ? 'var(--bull)' : 'var(--bear)' }]} yFormat={inrWhole} />
        <div className="lab-section">Trades</div>
        <div className="table-scroll lab-trades">
          {r.trades ? (
            <table className="pt-table">
              <thead><tr><th>Day</th><th>In</th><th>Out</th><th className="right">NIFTY</th><th>Legs (entry to exit)</th><th className="right">Net</th><th>Exit</th></tr></thead>
              <tbody>
                {r.tradeList.slice().reverse().map((t, i) => (
                  <tr key={`${t.day}-${t.entryT}-${i}`}>
                    <td>{t.day}</td><td>{timeIst(t.entryT)}</td><td>{timeIst(t.exitT)}</td>
                    <td className="right">{t.entryIndex.toFixed(0)} to {t.exitIndex.toFixed(0)}</td>
                    <td className="pt-note">{t.legs.map((l, k) => <div key={k}>{l.label} {l.entry.toFixed(2)} to {l.exit.toFixed(2)}</div>)}</td>
                    <td className={`right ${t.net > 0 ? 'pt-pos' : t.net < 0 ? 'pt-neg' : ''}`}>{inr(t.net, true)}</td><td>{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty-note">No trades: the conditions never lined up inside the window.</div>}
        </div>
        <div className="lab-section">How this was tested</div>
        <ul className="lab-assumptions">{r.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
      </div>
    </div>
  );
}
