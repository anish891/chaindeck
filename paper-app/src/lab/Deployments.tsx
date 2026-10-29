import { inr, timeIst } from '../format';
import { useConfirm } from '../hooks';
import type { Deployment } from '../types';

interface Props {
  deployments: Deployment[];
  error: string;
  onStatus: (id: string, status: 'active' | 'paused' | 'stopped') => void;
  onDelete: (id: string) => void;
}

export function Deployments({ deployments, error, onStatus, onDelete }: Props) {
  const confirm = useConfirm();
  return (
    <div className="section">
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">Live strategies</div>
          <span className="panel-note">Forward tests on real prices. Model gap compares each real fill with the backtest's modelled price.</span>
        </div>
        {!deployments.length && <div className="empty-note">Nothing deployed. Save a strategy, then use Deploy under its rules.</div>}
        {deployments.slice().reverse().map(d => {
          const r = d.report;
          const stopArmed = confirm.isArmed(`stop|${d.id}`);
          const gap = r.model.meanGapPct === null ? 'n/a' : `${r.model.meanGapPct > 0 ? '+' : ''}${r.model.meanGapPct}% (avg size ${r.model.meanAbsGapPct}%)`;
          const recent = (d.trades || []).slice(-8).reverse();
          return (
            <div className="dep" key={d.id}>
              <div className="dep-head">
                <span><b>{d.strategy.name}</b> <span className="pt-muted">on {d.accountName}, {d.strategy.interval}</span> <span className={`dep-status ${d.status}`}>{d.status}</span></span>
                <span className="dep-buttons">
                  {d.status === 'stopped' && <button type="button" className="pt-small" onClick={() => onDelete(d.id)}>Delete</button>}
                  {d.status === 'active' && <button type="button" className="pt-small" onClick={() => onStatus(d.id, 'paused')}>Pause</button>}
                  {d.status === 'paused' && <button type="button" className="pt-small" onClick={() => onStatus(d.id, 'active')}>Resume</button>}
                  {d.status !== 'stopped' && d.status !== 'stopping' && (
                    <button type="button" className={`pt-small${stopArmed ? ' pt-armed' : ''}`} onClick={() => {
                      if (!stopArmed) { confirm.arm(`stop|${d.id}`); return; }
                      confirm.clear();
                      onStatus(d.id, 'stopped');
                    }}>{stopArmed ? 'Confirm stop' : 'Stop'}</button>
                  )}
                </span>
              </div>
              <div className="dep-stats">
                <span>Trades <b>{r.trades}</b></span>
                <span>Win rate <b>{r.trades ? `${Math.round(r.winRate * 100)}%` : 'n/a'}</b></span>
                <span>Average <b>{r.trades ? inr(r.expectancy, true) : 'n/a'}</b></span>
                <span>Total <b className={r.totalNet > 0 ? 'pt-pos' : r.totalNet < 0 ? 'pt-neg' : ''}>{inr(r.totalNet, true)}</b></span>
                <span>Today <b>{d.day ? d.tradesToday : 0}/{d.strategy.entry.maxTradesPerDay}</b></span>
                <span title={r.model.note}>Model gap <b>{gap}</b></span>
              </div>
              {d.open && (
                <div className="pt-muted">
                  Open since {timeIst(d.open.entryT)} at NIFTY {d.open.entrySpot}: {d.open.legs.map(l => `${l.side} ${l.strike} ${l.optionType} @ ${l.entry.toFixed(2)}`).join(', ')}
                  {d.open.stopRs !== null ? `, stop ${inr(-d.open.stopRs)}` : ''}{d.open.targetRs !== null ? `, target ${inr(d.open.targetRs)}` : ''}
                </div>
              )}
              {recent.length > 0 && (
                <div className="table-scroll">
                  <table className="pt-table">
                    <thead><tr><th>Day</th><th>In</th><th>Out</th><th>Exit</th><th className="right">Net (real)</th><th className="right">Model P&amp;L</th></tr></thead>
                    <tbody>
                      {recent.map((t, i) => (
                        <tr key={`${t.day}-${t.entryT}-${i}`}>
                          <td>{t.day}</td><td>{timeIst(t.entryT)}</td><td>{timeIst(t.exitT)}</td><td>{t.reason}</td>
                          <td className={`right ${t.net > 0 ? 'pt-pos' : t.net < 0 ? 'pt-neg' : ''}`}>{inr(t.net, true)}</td>
                          <td className="right pt-muted">{t.modelNet === null ? 'n/a' : inr(t.modelNet, true)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="dep-log">{(d.log || []).slice(-4).reverse().map((l, i) => <div key={i}>{timeIst(l.at)} {l.text}</div>)}</div>
            </div>
          );
        })}
        <div className="pt-error" role="alert">{error}</div>
      </div>
    </div>
  );
}
