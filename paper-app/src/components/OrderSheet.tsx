import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { INDEX_INFO, inr, instLabel, instSymbol, px } from '../format';
import { buildOrder, emptyForm, lotsForRisk, quoteFor, riskRead, MAX_LOTS, MAX_SETUP } from '../ticket';
import { readPref, writePref } from '../theme';
import type { Selection, TicketForm } from '../ticket';
import type { Market, OrderType, PlaceResult, PreviewResult, Side } from '../types';

interface Props {
  accountId: string | null;
  market: Market | null;
  selection: Selection;
  /** setups already used on this account, offered as suggestions so the same setup is always spelled the same way */
  setups?: string[];
  /** the account's equity, so a trade's risk can be shown as a share of it */
  equity?: number | null;
  onSide: (side: Side) => void;
  onClose: () => void;
  /** called with a one-line summary after an order is accepted */
  onPlaced: (text: string) => void;
}

const PREVIEW_DELAY_MS = 350;
const typing = (el: EventTarget | null) => el instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

/** The buy / sell sheet that opens when a price in the chain is tapped: lots, market or limit, one button. */
export function OrderSheet({ accountId, market, selection, setups = [], equity = null, onSide, onClose, onPlaced }: Props) {
  const [budget, setBudget] = useState(() => readPref('paper_risk_budget') || '');
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
  const symbol = selection.instrument ? instSymbol(selection.instrument) : (market && market.symbol) || 'NIFTY';
  const lotSize = (market && (market.symbol || 'NIFTY') === symbol && market.lotSize) || INDEX_INFO[symbol].lotSize;

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'b') onSide('BUY');
      else if (k === 's') onSide('SELL');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, onSide]);

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
  const risk = riskRead(form, selection.side, quote, lotSize);
  const share = risk.maxLoss !== null && equity && equity > 0 ? ` (${((risk.maxLoss / equity) * 100).toFixed(1)}% of the account)` : '';
  const budgetNum = parseFloat(budget);
  const fit = lotsForRisk(budgetNum, risk.perLot);
  const changeBudget = (v: string) => { setBudget(v); writePref('paper_risk_budget', v); };

  return (
    <div className="pt-overlay" onClick={onClose}>
      <div className="pt-sheet" role="dialog" aria-modal="true" aria-label={`${verb} ${symbol} ${instLabel(selection.instrument)}`} tabIndex={-1} ref={ref} onClick={e => e.stopPropagation()}>
        <div className="pt-sheet-head">
          <div>
            <div className="pt-sheet-title">{symbol} {instLabel(selection.instrument)}</div>
            <div className="pt-muted">{quote && quote.ltp ? `Price ${px(quote.ltp)}` : 'No price right now'}{quote && (quote.bid || quote.ask) ? ` · bid ${px(quote.bid)} · ask ${px(quote.ask)}` : ''}</div>
          </div>
          <button type="button" className="pt-small" onClick={onClose} aria-label="Close">Close</button>
        </div>

        <div className="pt-sides" role="group" aria-label="Side">
          <button type="button" className={`pt-side pt-side-buy${selection.side === 'BUY' ? ' on' : ''}`} aria-pressed={selection.side === 'BUY'} onClick={() => onSide('BUY')}>Buy</button>
          <button type="button" className={`pt-side pt-side-sell${selection.side === 'SELL' ? ' on' : ''}`} aria-pressed={selection.side === 'SELL'} onClick={() => onSide('SELL')}>Sell</button>
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

        <label className="pt-field"><span className="pt-label">Setup <span className="pt-muted">(optional)</span></span>
          <input type="text" list="ptSetups" maxLength={MAX_SETUP} placeholder="e.g. Breakout" autoComplete="off" value={form.setup} onChange={e => set('setup', e.target.value)} aria-describedby="ptSetupHint" />
          <datalist id="ptSetups">{setups.map(s => <option key={s} value={s} />)}</datalist>
        </label>
        <div className="pt-hint" id="ptSetupHint">Name why you are taking this trade. Performance then shows each setup's win rate and expectancy. Only the entry needs it: exits are credited to the setup that opened the position.</div>

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

        {risk.basis !== 'unknown' && (
          <div className="pt-risk" data-basis={risk.basis}>
            <div className={risk.basis === 'uncapped' ? 'pt-warnc' : undefined}>
              {risk.basis === 'stop' && <>Loss if the stop is hit: <b>{inr(risk.maxLoss)}</b>{share}.</>}
              {risk.basis === 'premium' && <>Most this can lose: <b>{inr(risk.maxLoss)}</b>{share}, the premium paid. A stop loss (More options) lowers it.</>}
              {risk.basis === 'uncapped' && <>No stop loss: the loss on a sold option is not capped. Add one under More options.</>}
              {risk.reward !== null && <> Gain at the target: <b>{inr(risk.reward)}</b>{risk.ratio !== null && <>, {risk.ratio.toFixed(1)} times the risk</>}.</>}
            </div>
            {risk.perLot !== null && (
              <div className="pt-risk-size">
                <label htmlFor="ptRiskBudget">Risk per trade ₹</label>
                <input id="ptRiskBudget" type="number" min={0} step={500} inputMode="numeric" placeholder="e.g. 2000" value={budget} onChange={e => changeBudget(e.target.value)} />
                {budgetNum > 0 && (fit >= 1
                  ? <button type="button" className="pt-small" onClick={() => set('lots', String(fit))} disabled={fit === lots}>{fit === lots ? `${fit} lot${fit === 1 ? '' : 's'} fits` : `Use ${fit} lot${fit === 1 ? '' : 's'}`}</button>
                  : <span className="pt-warnc">One lot risks {inr(risk.perLot)}, more than this.</span>)}
              </div>
            )}
          </div>
        )}
        <div className={`pt-preview${preview.warn ? ' pt-warn' : ''}`} aria-live="polite">{preview.text}</div>
        {error && <div className="pt-error" role="alert">{error}</div>}
        <button type="button" className={`pt-primary pt-wide ${selection.side === 'SELL' ? 'pt-sell' : 'pt-buy'}`} onClick={place} disabled={busy || lots < 1}>
          {verb} {lots} lot{lots === 1 ? '' : 's'}
        </button>
        <div className="panel-note">Orders last for the day. Margin is an estimate, not SPAN. Risk figures are before charges. Keys: B buy, S sell, Esc close.</div>
      </div>
    </div>
  );
}
