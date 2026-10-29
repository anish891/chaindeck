import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { inr, instLabel, px } from '../format';
import { buildOrder, emptyForm, quoteFor } from '../ticket';
import type { Selection, TicketForm } from '../ticket';
import type { Market, OrderType, PlaceResult, PreviewResult, Side } from '../types';

interface Props {
  accountId: string | null;
  market: Market | null;
  selection: Selection;
  onSide: (side: Side) => void;
  onPlaced: () => void;
}

const PREVIEW_DELAY_MS = 350;

export function Ticket({ accountId, market, selection, onSide, onPlaced }: Props) {
  const [form, setForm] = useState<TicketForm>(emptyForm);
  const [preview, setPreview] = useState<{ text: string; warn: boolean }>({ text: '', warn: false });
  const [result, setResult] = useState<{ text: string; ok: boolean }>({ text: '', ok: true });
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const set = <K extends keyof TicketForm>(k: K, v: TicketForm[K]) => setForm(f => ({ ...f, [k]: v }));
  const quote = quoteFor(market, selection.instrument);
  const lots = parseInt(form.lots, 10) || 0;
  const lotSize = (market && market.lotSize) || 65;

  // picking a strike clears the last result and starts the limit price at the current price
  useEffect(() => {
    if (!selection.instrument) return;
    setResult({ text: '', ok: true });
    const q = quoteFor(market, selection.instrument);
    if (q && q.ltp) setForm(f => ({ ...f, limit: q.ltp!.toFixed(2) }));
    if (window.matchMedia('(max-width: 1100px)').matches) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new pick should do this, not every price refresh
  }, [selection.nonce]);

  // preview what the order would do, a moment after the last edit
  useEffect(() => {
    if (!selection.instrument || !accountId) return undefined;
    let cancelled = false;
    const id = setTimeout(async () => {
      const r = await api<PreviewResult>(`/accounts/${encodeURIComponent(accountId)}/orders/preview`, { method: 'POST', body: buildOrder(form, { instrument: selection.instrument!, side: selection.side }) });
      if (cancelled) return;
      if (!r.ok) { setPreview({ text: r.error || 'Cannot check this order.', warn: true }); return; }
      const free = `Free cash after: ${inr(r.availableAfter)}${r.marginAfter ? ` (margin ${inr(r.marginAfter)})` : ''}.`;
      setPreview({
        text: r.fill ? `Fills now at ${px(r.fill.price)} for ${inr(r.fill.price * r.fill.qty)}, charges ${inr(r.fill.charges)}. ${free}` : `Waits until the price is reached, then fills on a newer snapshot. ${free}`,
        warn: false
      });
    }, PREVIEW_DELAY_MS);
    return () => { cancelled = true; clearTimeout(id); };
  }, [form, selection.instrument, selection.side, accountId]);

  async function place() {
    if (!selection.instrument || !accountId || busy) return;
    setBusy(true);
    const r = await api<PlaceResult>(`/accounts/${encodeURIComponent(accountId)}/orders`, { method: 'POST', body: buildOrder(form, { instrument: selection.instrument, side: selection.side }) });
    setBusy(false);
    if (!r.ok) { setResult({ text: r.error || 'Order refused.', ok: false }); return; }
    const verb = r.order.side === 'BUY' ? 'Bought' : 'Sold';
    setResult({
      text: r.trade ? `${verb} ${r.order.lots} lot${r.order.lots === 1 ? '' : 's'} of ${instLabel(r.order.instrument)} at ${px(r.trade.price)}.` : `Order ${r.order.id} is waiting (${r.order.orderType}).`,
      ok: true
    });
    set('note', '');
    setPreview({ text: '', warn: false });
    onPlaced();
  }

  const needsLimit = form.type === 'LIMIT' || form.type === 'SL';
  const needsTrigger = form.type === 'SL' || form.type === 'SL-M';

  return (
    <div className="panel pt-ticket" ref={ref}>
      <div className="panel-head"><div className="panel-title">Order ticket</div></div>
      <div className="pt-ticket-inst">
        {!selection.instrument ? 'Pick a strike from the chain.' : (
          <>
            <b>NIFTY {instLabel(selection.instrument)}</b>
            {quote && <span className="pt-muted"> LTP {px(quote.ltp)} · bid {px(quote.bid)} · ask {px(quote.ask)}</span>}
          </>
        )}
      </div>
      <div className="pt-field">
        <span className="pt-label">Side</span>
        <div className="seg" role="group" aria-label="Side">
          <button type="button" className={`seg-btn${selection.side === 'BUY' ? ' active' : ''}`} onClick={() => onSide('BUY')}>Buy</button>
          <button type="button" className={`seg-btn${selection.side === 'SELL' ? ' active' : ''}`} onClick={() => onSide('SELL')}>Sell</button>
        </div>
      </div>
      <label className="pt-field"><span className="pt-label">Lots</span><input type="number" min={1} max={20} step={1} value={form.lots} onChange={e => set('lots', e.target.value)} /></label>
      <label className="pt-field"><span className="pt-label">Order type</span>
        <select value={form.type} onChange={e => set('type', e.target.value as OrderType)}>
          <option value="MARKET">Market</option>
          <option value="LIMIT">Limit</option>
          <option value="SL">Stop limit (SL)</option>
          <option value="SL-M">Stop market (SL-M)</option>
        </select>
      </label>
      {needsLimit && <label className="pt-field"><span className="pt-label">Limit price</span><input type="number" min={0.05} step={0.05} value={form.limit} onChange={e => set('limit', e.target.value)} /></label>}
      {needsTrigger && <label className="pt-field"><span className="pt-label">Trigger price</span><input type="number" min={0.05} step={0.05} value={form.trigger} onChange={e => set('trigger', e.target.value)} /></label>}
      <label className="pt-check"><input type="checkbox" checked={form.bracket} onChange={e => set('bracket', e.target.checked)} /> Add target and stop loss</label>
      {form.bracket && (
        <div className="pt-bracket">
          <label className="pt-field"><span className="pt-label">Target</span><input type="number" min={0.05} step={0.05} value={form.target} onChange={e => set('target', e.target.value)} /></label>
          <label className="pt-field"><span className="pt-label">Stop loss</span><input type="number" min={0.05} step={0.05} value={form.stop} onChange={e => set('stop', e.target.value)} /></label>
        </div>
      )}
      <label className="pt-field pt-field-col"><span className="pt-label">Note (why this trade)</span>
        <textarea rows={2} maxLength={500} placeholder="Optional, kept in the journal" value={form.note} onChange={e => set('note', e.target.value)} />
      </label>
      <div className={`pt-preview${preview.warn ? ' pt-warn' : ''}`} aria-live="polite">{selection.instrument ? preview.text : ''}</div>
      <button type="button" className={`pt-primary ${selection.side === 'SELL' ? 'pt-sell' : 'pt-buy'}`} onClick={place} disabled={!selection.instrument || busy}>
        {selection.instrument ? `${selection.side === 'BUY' ? 'Buy' : 'Sell'} ${lots} lot${lots === 1 ? '' : 's'} (${lots * lotSize} qty)` : 'Place order'}
      </button>
      <div className={`pt-result${result.ok ? ' pt-okmsg' : ' pt-warn'}`} role="status">{result.text}</div>
      <div className="panel-note">Orders are DAY orders: anything unfilled is cancelled at 15:30. Waiting orders fill only on a newer NSE snapshot. Margin is an estimate, not SPAN.</div>
    </div>
  );
}
