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
  onClose: () => void;
  /** called with a one-line summary after an order is accepted */
  onPlaced: (text: string) => void;
}

const PREVIEW_DELAY_MS = 350;
const MAX_LOTS = 20;

/** The buy / sell sheet that opens when a price in the chain is tapped: lots, market or limit, one button. */
export function OrderSheet({ accountId, market, selection, onSide, onClose, onPlaced }: Props) {
  const [form, setForm] = useState<TicketForm>(emptyForm);
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState<{ text: string; warn: boolean }>({ text: '', warn: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const set = <K extends keyof TicketForm>(k: K, v: TicketForm[K]) => setForm(f => ({ ...f, [k]: v }));
  const open = !!selection.instrument;
  const quote = quoteFor(market, selection.instrument);
  const lots = parseInt(form.lots, 10) || 0;
  const lotSize = (market && market.lotSize) || 65;

  // every pick starts a fresh order: 1 lot, market, the limit price set to the current price
  useEffect(() => {
    if (!selection.instrument) return;
    const q = quoteFor(market, selection.instrument);
    setForm({ ...emptyForm(), limit: q && q.ltp ? q.ltp.toFixed(2) : '' });
    setMore(false);
    setError('');
    setPreview({ text: '', warn: false });
    ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new pick should reset the form, not every price refresh
  }, [selection.nonce]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // preview what the order would do, a moment after the last edit
  useEffect(() => {
    if (!selection.instrument || !accountId) return undefined;
    let cancelled = false;
    const id = setTimeout(async () => {
      const r = await api<PreviewResult>(`/accounts/${encodeURIComponent(accountId)}/orders/preview`, { method: 'POST', body: buildOrder(form, { instrument: selection.instrument!, side: selection.side }) });
      if (cancelled) return;
      if (!r.ok) { setPreview({ text: r.error || 'Cannot check this order.', warn: true }); return; }
      const free = `Cash left after: ${inr(r.availableAfter)}${r.marginAfter ? ` (margin ${inr(r.marginAfter)})` : ''}.`;
      setPreview({
        text: r.fill ? `About ${inr(r.fill.price * r.fill.qty)} at ${px(r.fill.price)}, charges ${inr(r.fill.charges)}. ${free}` : `Waits until the price is reached. ${free}`,
        warn: false
      });
    }, PREVIEW_DELAY_MS);
    return () => { cancelled = true; clearTimeout(id); };
  }, [form, selection.instrument, selection.side, accountId]);

  async function place() {
    if (!selection.instrument || !accountId || busy) return;
    setBusy(true);
    setError('');
    const r = await api<PlaceResult>(`/accounts/${encodeURIComponent(accountId)}/orders`, { method: 'POST', body: buildOrder(form, { instrument: selection.instrument, side: selection.side }) });
    setBusy(false);
    if (!r.ok) { setError(r.error || 'Order refused.'); return; }
    const verb = r.order.side === 'BUY' ? 'Bought' : 'Sold';
    onPlaced(r.trade
      ? `${verb} ${r.order.lots} lot${r.order.lots === 1 ? '' : 's'} of ${instLabel(r.order.instrument)} at ${px(r.trade.price)}.`
      : `Order placed for ${instLabel(r.order.instrument)}. It waits until the price is reached.`);
  }

  if (!open || !selection.instrument) return null;

  const step = (d: number) => set('lots', String(Math.min(MAX_LOTS, Math.max(1, lots + d))));
  const stopOrder = form.type === 'SL' || form.type === 'SL-M';
  const needsLimit = form.type === 'LIMIT' || form.type === 'SL';
  const needsTrigger = stopOrder;
  const verb = selection.side === 'BUY' ? 'Buy' : 'Sell';

  return (
    <div className="pt-overlay" onClick={onClose}>
      <div className="pt-sheet" role="dialog" aria-modal="true" aria-label={`${verb} NIFTY ${instLabel(selection.instrument)}`} tabIndex={-1} ref={ref} onClick={e => e.stopPropagation()}>
        <div className="pt-sheet-head">
          <div>
            <div className="pt-sheet-title">NIFTY {instLabel(selection.instrument)}</div>
            <div className="pt-muted">{quote && quote.ltp ? `Price ${px(quote.ltp)}` : 'No price right now'}{quote && (quote.bid || quote.ask) ? ` · bid ${px(quote.bid)} · ask ${px(quote.ask)}` : ''}</div>
          </div>
          <button type="button" className="pt-small" onClick={onClose} aria-label="Close">Close</button>
        </div>

        <div className="pt-sides" role="group" aria-label="Side">
          <button type="button" className={`pt-side pt-side-buy${selection.side === 'BUY' ? ' on' : ''}`} onClick={() => onSide('BUY')}>Buy</button>
          <button type="button" className={`pt-side pt-side-sell${selection.side === 'SELL' ? ' on' : ''}`} onClick={() => onSide('SELL')}>Sell</button>
        </div>

        <div className="pt-field">
          <span className="pt-label">Lots <span className="pt-muted">({lots * lotSize} qty)</span></span>
          <span className="pt-stepper">
            <button type="button" onClick={() => step(-1)} disabled={lots <= 1} aria-label="One lot fewer">-</button>
            <input type="number" min={1} max={MAX_LOTS} step={1} aria-label="Lots" value={form.lots} onChange={e => set('lots', e.target.value)} />
            <button type="button" onClick={() => step(1)} disabled={lots >= MAX_LOTS} aria-label="One lot more">+</button>
          </span>
        </div>

        <div className="pt-field">
          <span className="pt-label">Price</span>
          <div className="seg" role="group" aria-label="Price type">
            <button type="button" className={`seg-btn${form.type === 'MARKET' ? ' active' : ''}`} onClick={() => set('type', 'MARKET')}>Market</button>
            <button type="button" className={`seg-btn${form.type === 'LIMIT' ? ' active' : ''}`} onClick={() => set('type', 'LIMIT')}>Limit</button>
          </div>
        </div>
        {needsLimit && <label className="pt-field"><span className="pt-label">{form.type === 'SL' ? 'Limit price' : 'Price'}</span><input type="number" min={0.05} step={0.05} value={form.limit} onChange={e => set('limit', e.target.value)} /></label>}

        <button type="button" className="pt-more" aria-expanded={more} onClick={() => setMore(m => !m)}>{more ? 'Fewer options' : 'More options'}</button>
        {more && (
          <div className="pt-morebox">
            <label className="pt-field"><span className="pt-label">Stop order</span>
              <select value={stopOrder ? form.type : 'NONE'} onChange={e => set('type', (e.target.value === 'NONE' ? 'MARKET' : e.target.value) as OrderType)}>
                <option value="NONE">No</option>
                <option value="SL">Stop limit (SL)</option>
                <option value="SL-M">Stop market (SL-M)</option>
              </select>
            </label>
            {needsTrigger && <label className="pt-field"><span className="pt-label">Trigger price</span><input type="number" min={0.05} step={0.05} value={form.trigger} onChange={e => set('trigger', e.target.value)} /></label>}
            <label className="pt-check"><input type="checkbox" checked={form.bracket} onChange={e => set('bracket', e.target.checked)} /> Add target and stop loss</label>
            {form.bracket && (
              <div className="pt-bracket">
                <label className="pt-field"><span className="pt-label">Target price</span><input type="number" min={0.05} step={0.05} value={form.target} onChange={e => set('target', e.target.value)} /></label>
                <label className="pt-field"><span className="pt-label">Stop loss price</span><input type="number" min={0.05} step={0.05} value={form.stop} onChange={e => set('stop', e.target.value)} /></label>
              </div>
            )}
            <label className="pt-field pt-field-col"><span className="pt-label">Note (why this trade)</span>
              <textarea rows={2} maxLength={500} placeholder="Optional, kept in the journal" value={form.note} onChange={e => set('note', e.target.value)} />
            </label>
          </div>
        )}

        <div className={`pt-preview${preview.warn ? ' pt-warn' : ''}`} aria-live="polite">{preview.text}</div>
        {error && <div className="pt-error" role="alert">{error}</div>}
        <button type="button" className={`pt-primary pt-wide ${selection.side === 'SELL' ? 'pt-sell' : 'pt-buy'}`} onClick={place} disabled={busy || lots < 1}>
          {verb} {lots} lot{lots === 1 ? '' : 's'}
        </button>
        <div className="panel-note">Orders last for the day. Margin is an estimate, not SPAN.</div>
      </div>
    </div>
  );
}
