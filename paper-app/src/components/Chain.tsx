import { memo, useEffect, useRef } from 'react';
import { instrumentKey, shortExpiry } from '../format';
import { useFlash, useLivePrice } from '../live';
import type { IndexSymbol, Market, OptionType, Quote, Side } from '../types';

interface Props {
  market: Market | null;
  /** false until the first market message has arrived (the table then shows a skeleton, not "unavailable") */
  loaded: boolean;
  held: Set<string>;
  onPick: (strike: number, type: OptionType, side: Side) => void;
  onExpiry: (expiry: string) => void;
}

interface PriceProps {
  strike: number;
  type: OptionType;
  hasQuote: boolean;
  snapshot: number | null;
  isHeld: boolean;
  onPick: Props['onPick'];
}

/**
 * One tappable price. Tapping opens the order sheet on Buy; the sheet has the Sell switch.
 * It reads its own price from the tick store, so a tick re-renders this cell alone, and flashes green or red when it moves.
 */
const Price = memo(function Price({ strike, type, hasQuote, snapshot, isHeld, onPick }: PriceProps) {
  const price = useLivePrice(strike, type, snapshot);
  const flash = useFlash(price);
  if (!hasQuote) return <span className="pt-muted">n/a</span>;
  return (
    <button type="button" className={`pt-px${isHeld ? ' held' : ''} ${flash}`.trim()} aria-label={`Trade ${strike} ${type}${isHeld ? ' (you hold this)' : ''}`} onClick={() => onPick(strike, type, 'BUY')}>
      {price ? price.toFixed(2) : 'n/a'}
    </button>
  );
});

interface RowProps {
  strike: number;
  ce: Quote | null;
  pe: Quote | null;
  atm: boolean;
  ceItm: boolean;
  peItm: boolean;
  ceHeld: boolean;
  peHeld: boolean;
  onPick: Props['onPick'];
}

/** A strike row. Memoized on plain values, so a new market snapshot re-renders only the rows whose numbers changed. */
const Row = memo(function Row({ strike, ce, pe, atm, ceItm, peItm, ceHeld, peHeld, onPick }: RowProps) {
  return (
    <tr className={atm ? 'pt-atm' : ''}>
      <td className={`center${ceItm ? ' pt-itm' : ''}`}><Price strike={strike} type="CE" hasQuote={!!ce} snapshot={ce ? ce.ltp : null} isHeld={ceHeld} onPick={onPick} /></td>
      <td className="center pt-strike">{strike}</td>
      <td className={`center${peItm ? ' pt-itm' : ''}`}><Price strike={strike} type="PE" hasQuote={!!pe} snapshot={pe ? pe.ltp : null} isHeld={peHeld} onPick={onPick} /></td>
    </tr>
  );
}, (a, b) => a.strike === b.strike && a.atm === b.atm && a.ceItm === b.ceItm && a.peItm === b.peItm && a.ceHeld === b.ceHeld && a.peHeld === b.peHeld
  && a.onPick === b.onPick && !!a.ce === !!b.ce && !!a.pe === !!b.pe && (a.ce ? a.ce.ltp : null) === (b.ce ? b.ce.ltp : null) && (a.pe ? a.pe.ltp : null) === (b.pe ? b.pe.ltp : null));

const SKELETON_ROWS = 9;

export function Chain({ market, loaded, held, onPick, onExpiry }: Props) {
  const scroll = useRef<HTMLDivElement | null>(null);
  const expiry = market && market.expiry;
  const atm = market && market.atmStrike;
  // a stable callback, so memoized rows are not re-rendered just because the parent rendered
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const stablePick = useRef<Props['onPick']>((strike, type, side) => pickRef.current(strike, type, side)).current;

  // open on the at-the-money strikes, not the far in-the-money end; again when the expiry changes
  useEffect(() => {
    const box = scroll.current;
    const row = box && box.querySelector<HTMLElement>('tr.pt-atm');
    if (box && row) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2);
  }, [expiry, atm !== null]);

  const symbol: IndexSymbol = (market && market.symbol) || 'NIFTY';
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">{market && market.symbol === 'SENSEX' ? 'SENSEX option chain' : 'Option chain'}</div>
        <div className="seg" role="group" aria-label="Expiry">
          {market && market.expiries.map(e => (
            <button type="button" key={e} className={`seg-btn${e === market.expiry ? ' active' : ''}`} onClick={() => onExpiry(e)}>{shortExpiry(e)}</button>
          ))}
        </div>
      </div>
      <div className="table-scroll pt-chain-scroll" ref={scroll} aria-busy={!loaded}>
        <table className="pt-table pt-chain">
          <thead>
            <tr><th className="center">Calls</th><th className="center">Strike</th><th className="center">Puts</th></tr>
          </thead>
          <tbody>
            {!loaded && Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <tr key={i} className="skeleton-row" aria-hidden="true"><td className="center"><span className="skeleton" /></td><td className="center"><span className="skeleton" /></td><td className="center"><span className="skeleton" /></td></tr>
            ))}
            {loaded && !market && (
              <tr><td colSpan={3} className="empty-note state-error" role="alert">
                <strong>Option chain unavailable.</strong> The server has no live prices right now. It keeps retrying; this table fills in by itself when prices return.
              </td></tr>
            )}
            {market && market.strikes.length === 0 && <tr><td colSpan={3} className="empty-note">No strikes listed for this expiry. Pick another expiry above.</td></tr>}
            {market && market.expiry && market.strikes.map(r => (
              <Row
                key={r.strike}
                strike={r.strike}
                ce={r.CE}
                pe={r.PE}
                atm={r.strike === market.atmStrike}
                ceItm={market.spot > r.strike}
                peItm={market.spot < r.strike}
                ceHeld={held.has(instrumentKey(market.expiry as string, r.strike, 'CE', symbol))}
                peHeld={held.has(instrumentKey(market.expiry as string, r.strike, 'PE', symbol))}
                onPick={stablePick}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-note">Tap a price to buy or sell. A dot means you hold it. Prices from Upstox. Lot size {market ? market.lotSize : 'n/a'}.</div>
    </div>
  );
}
