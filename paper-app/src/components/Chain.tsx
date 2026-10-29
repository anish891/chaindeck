import { instrumentKey, shortExpiry } from '../format';
import type { Market, OptionType, Quote, Side } from '../types';
import type { Selection } from '../ticket';

interface Props {
  market: Market | null;
  held: Set<string>;
  selection: Selection;
  onPick: (strike: number, type: OptionType, side: Side) => void;
  onExpiry: (expiry: string) => void;
}

const leg = (q: Quote | null, f: 'ltp' | 'bid' | 'ask') => (q && q[f] ? (q[f] as number).toFixed(2) : 'n/a');
const book = (q: Quote | null) => (q && (q.bid || q.ask) ? `${leg(q, 'bid')} / ${leg(q, 'ask')}` : 'n/a');

function BuySell({ strike, type, expiry, held, selection, onPick }: { strike: number; type: OptionType; expiry: string } & Pick<Props, 'held' | 'selection' | 'onPick'>) {
  const key = instrumentKey(expiry, strike, type);
  const sel = selection.instrument === key;
  return (
    <span className={`pt-bs${held.has(key) ? ' held' : ''}`}>
      <button type="button" className={`pt-b${sel && selection.side === 'BUY' ? ' on' : ''}`} title={`Buy ${strike} ${type}`} aria-label={`Buy ${strike} ${type}`} onClick={() => onPick(strike, type, 'BUY')}>B</button>
      <button type="button" className={`pt-s${sel && selection.side === 'SELL' ? ' on' : ''}`} title={`Sell ${strike} ${type}`} aria-label={`Sell ${strike} ${type}`} onClick={() => onPick(strike, type, 'SELL')}>S</button>
    </span>
  );
}

export function Chain({ market, held, selection, onPick, onExpiry }: Props) {
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
      <div className="table-scroll">
        <table className="pt-table pt-chain">
          <thead>
            <tr>
              <th className="right pt-book">Bid / Ask</th><th className="right">LTP</th><th className="center">Calls</th>
              <th className="center">Strike</th>
              <th className="center">Puts</th><th className="right">LTP</th><th className="right pt-book">Bid / Ask</th>
            </tr>
          </thead>
          <tbody>
            {!market && <tr><td colSpan={7} className="empty-note">Option chain unavailable right now.</td></tr>}
            {market && market.strikes.length === 0 && <tr><td colSpan={7} className="empty-note">No strikes for this expiry.</td></tr>}
            {market && market.expiry && market.strikes.map(r => {
              const itmCall = market.spot > r.strike;
              const itmPut = market.spot < r.strike;
              const expiry = market.expiry as string;
              return (
                <tr key={r.strike} className={r.strike === market.atmStrike ? 'pt-atm' : ''}>
                  <td className={`right muted pt-book${itmCall ? ' pt-itm' : ''}`}>{book(r.CE)}</td>
                  <td className={`right${itmCall ? ' pt-itm' : ''}`}>{leg(r.CE, 'ltp')}</td>
                  <td className="center">{r.CE && <BuySell strike={r.strike} type="CE" expiry={expiry} held={held} selection={selection} onPick={onPick} />}</td>
                  <td className="center pt-strike">{r.strike}</td>
                  <td className="center">{r.PE && <BuySell strike={r.strike} type="PE" expiry={expiry} held={held} selection={selection} onPick={onPick} />}</td>
                  <td className={`right${itmPut ? ' pt-itm' : ''}`}>{leg(r.PE, 'ltp')}</td>
                  <td className={`right muted pt-book${itmPut ? ' pt-itm' : ''}`}>{book(r.PE)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="panel-note">Prices from NSE, refreshed about once a minute. B buys, S sells. Lot size {market ? market.lotSize : 'n/a'}.</div>
    </div>
  );
}
