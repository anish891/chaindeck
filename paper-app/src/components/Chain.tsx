import { useEffect, useRef, useState } from 'react';
import { compact, instrumentKey, shortExpiry } from '../format';
import { readPref, writePref } from '../theme';
import type { IndexSymbol, Market, OptionType, Quote, Side } from '../types';

interface Props {
  market: Market | null;
  held: Set<string>;
  onPick: (strike: number, type: OptionType, side: Side) => void;
  onExpiry: (expiry: string) => void;
}

const ltp = (q: Quote | null) => (q && q.ltp ? q.ltp.toFixed(2) : 'n/a');
const iv = (q: Quote | null) => (q && q.iv ? `${q.iv.toFixed(1)}%` : 'n/a');
const oi = (q: Quote | null) => compact(q ? q.oi : null);

/** One tappable price. Tapping opens the order sheet on Buy; the sheet has the Sell switch. Hovering shows the bid and ask. */
function Price({ strike, type, expiry, symbol, q, held, onPick }: { strike: number; type: OptionType; expiry: string; symbol: IndexSymbol; q: Quote | null } & Pick<Props, 'held' | 'onPick'>) {
  if (!q) return <span className="pt-muted">n/a</span>;
  const isHeld = held.has(instrumentKey(expiry, strike, type, symbol));
  return (
    <button type="button" className={`pt-px${isHeld ? ' held' : ''}`} title={q.bid || q.ask ? `Bid ${q.bid ? q.bid.toFixed(2) : 'n/a'} · Ask ${q.ask ? q.ask.toFixed(2) : 'n/a'}` : undefined} aria-label={`Trade ${strike} ${type}${isHeld ? ' (you hold this)' : ''}`} onClick={() => onPick(strike, type, 'BUY')}>
      {ltp(q)}
    </button>
  );
}

export function Chain({ market, held, onPick, onExpiry }: Props) {
  const scroll = useRef<HTMLDivElement | null>(null);
  const expiry = market && market.expiry;
  const atm = market && market.atmStrike;
  // also show each side's open interest and implied volatility (remembered in this browser)
  const [details, setDetails] = useState(() => readPref('paper_chain_details') === '1');
  const toggleDetails = () => setDetails(d => { writePref('paper_chain_details', d ? '0' : '1'); return !d; });
  const cols = details ? 7 : 3;

  // open on the at-the-money strikes, not the far in-the-money end; again when the expiry changes
  useEffect(() => {
    const box = scroll.current;
    const row = box && box.querySelector<HTMLElement>('tr.pt-atm');
    if (box && row) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2);
  }, [expiry, atm !== null]);

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">{market && market.symbol === 'SENSEX' ? 'SENSEX option chain' : 'Option chain'}</div>
        <div className="pt-chain-tools">
          <button type="button" className={`pt-small pt-toggle${details ? ' on' : ''}`} aria-pressed={details} onClick={toggleDetails} title="Show open interest and implied volatility next to each price">OI and IV</button>
          <div className="seg" role="group" aria-label="Expiry">
            {market && market.expiries.map(e => (
              <button type="button" key={e} className={`seg-btn${e === market.expiry ? ' active' : ''}`} aria-pressed={e === market.expiry} onClick={() => onExpiry(e)}>{shortExpiry(e)}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="table-scroll pt-chain-scroll" ref={scroll}>
        <table className="pt-table pt-chain">
          <thead>
            <tr>
              {details && <th className="right">OI</th>}
              {details && <th className="right">IV</th>}
              <th className="center">Calls</th><th className="center">Strike</th><th className="center">Puts</th>
              {details && <th>IV</th>}
              {details && <th>OI</th>}
            </tr>
          </thead>
          <tbody>
            {!market && <tr><td colSpan={cols} className="empty-note">Option chain unavailable right now.</td></tr>}
            {market && market.strikes.length === 0 && <tr><td colSpan={cols} className="empty-note">No strikes for this expiry.</td></tr>}
            {market && market.expiry && market.strikes.map(r => {
              const expiry = market.expiry as string;
              const symbol = market.symbol || 'NIFTY';
              const isAtm = r.strike === market.atmStrike;
              const ceCls = market.spot > r.strike ? ' pt-itm' : '';
              const peCls = market.spot < r.strike ? ' pt-itm' : '';
              return (
                <tr key={r.strike} className={isAtm ? 'pt-atm' : ''}>
                  {details && <td className={`right pt-detail${ceCls}`}>{oi(r.CE)}</td>}
                  {details && <td className={`right pt-detail${ceCls}`}>{iv(r.CE)}</td>}
                  <td className={`center${ceCls}`}><Price strike={r.strike} type="CE" expiry={expiry} symbol={symbol} q={r.CE} held={held} onPick={onPick} /></td>
                  <td className="center pt-strike">{r.strike}{isAtm && <span className="pt-atm-tag"> ATM</span>}</td>
                  <td className={`center${peCls}`}><Price strike={r.strike} type="PE" expiry={expiry} symbol={symbol} q={r.PE} held={held} onPick={onPick} /></td>
                  {details && <td className={`pt-detail${peCls}`}>{iv(r.PE)}</td>}
                  {details && <td className={`pt-detail${peCls}`}>{oi(r.PE)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="panel-note">Tap a price to buy or sell. A dot means you hold it. Shaded prices are in the money. Hover a price for its bid and ask. Prices from Upstox. Lot size {market ? market.lotSize : 'n/a'}.</div>
    </div>
  );
}
