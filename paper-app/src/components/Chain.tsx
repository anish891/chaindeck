import { useEffect, useRef } from 'react';
import { instrumentKey, shortExpiry } from '../format';
import type { Market, OptionType, Quote, Side } from '../types';

interface Props {
  market: Market | null;
  held: Set<string>;
  onPick: (strike: number, type: OptionType, side: Side) => void;
  onExpiry: (expiry: string) => void;
}

const ltp = (q: Quote | null) => (q && q.ltp ? q.ltp.toFixed(2) : 'n/a');

/** One tappable price. Tapping opens the order sheet on Buy; the sheet has the Sell switch. */
function Price({ strike, type, expiry, q, held, onPick }: { strike: number; type: OptionType; expiry: string; q: Quote | null } & Pick<Props, 'held' | 'onPick'>) {
  if (!q) return <span className="pt-muted">n/a</span>;
  const isHeld = held.has(instrumentKey(expiry, strike, type));
  return (
    <button type="button" className={`pt-px${isHeld ? ' held' : ''}`} aria-label={`Trade ${strike} ${type}${isHeld ? ' (you hold this)' : ''}`} onClick={() => onPick(strike, type, 'BUY')}>
      {ltp(q)}
    </button>
  );
}

export function Chain({ market, held, onPick, onExpiry }: Props) {
  const scroll = useRef<HTMLDivElement | null>(null);
  const expiry = market && market.expiry;
  const atm = market && market.atmStrike;

  // open on the at-the-money strikes, not the far in-the-money end; again when the expiry changes
  useEffect(() => {
    const box = scroll.current;
    const row = box && box.querySelector<HTMLElement>('tr.pt-atm');
    if (box && row) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2);
  }, [expiry, atm !== null]);

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Option chain</div>
        <div className="seg" role="group" aria-label="Expiry">
          {market && market.expiries.map(e => (
            <button type="button" key={e} className={`seg-btn${e === market.expiry ? ' active' : ''}`} onClick={() => onExpiry(e)}>{shortExpiry(e)}</button>
          ))}
        </div>
      </div>
      <div className="table-scroll pt-chain-scroll" ref={scroll}>
        <table className="pt-table pt-chain">
          <thead>
            <tr><th className="center">Calls</th><th className="center">Strike</th><th className="center">Puts</th></tr>
          </thead>
          <tbody>
            {!market && <tr><td colSpan={3} className="empty-note">Option chain unavailable right now.</td></tr>}
            {market && market.strikes.length === 0 && <tr><td colSpan={3} className="empty-note">No strikes for this expiry.</td></tr>}
            {market && market.expiry && market.strikes.map(r => {
              const expiry = market.expiry as string;
              return (
                <tr key={r.strike} className={r.strike === market.atmStrike ? 'pt-atm' : ''}>
                  <td className={`center${market.spot > r.strike ? ' pt-itm' : ''}`}><Price strike={r.strike} type="CE" expiry={expiry} q={r.CE} held={held} onPick={onPick} /></td>
                  <td className="center pt-strike">{r.strike}</td>
                  <td className={`center${market.spot < r.strike ? ' pt-itm' : ''}`}><Price strike={r.strike} type="PE" expiry={expiry} q={r.PE} held={held} onPick={onPick} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="panel-note">Tap a price to buy or sell. A dot means you hold it. Prices from NSE, about once a minute. Lot size {market ? market.lotSize : 'n/a'}.</div>
    </div>
  );
}
