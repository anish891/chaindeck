import { NumField } from '../components/NumField';
import { CONDITION_LABELS, CONDITION_ORDER, DAYS, MAX_CONDITIONS, MAX_LEGS, defaultCondition, exitRule, newLeg, offsetLabel } from '../strategy';
import type { Condition, ConditionType, ExitRule, Interval, Leg, Strategy } from '../types';
import { useState } from 'react';

interface Props {
  strategy: Strategy;
  onChange: (s: Strategy) => void;
  error: string;
  onError: (e: string) => void;
}

const OFFSETS = Array.from({ length: 41 }, (_, k) => k - 20);

function ConditionFields({ c, onChange }: { c: Condition; onChange: (c: Condition) => void }) {
  const opSel = (op: 'above' | 'below', set: (v: 'above' | 'below') => void) => (
    <select value={op} onChange={e => set(e.target.value as 'above' | 'below')} aria-label="Comparison"><option value="above">above</option><option value="below">below</option></select>
  );
  switch (c.type) {
    case 'gap':
    case 'dayMove':
      return <>{opSel(c.op, op => onChange({ ...c, op }))} <NumField value={c.pct} onChange={pct => onChange({ ...c, pct })} step={0.05} min={-10} max={10} label="Percent" /> %</>;
    case 'orb':
      return (
        <>
          <select value={c.direction} onChange={e => onChange({ ...c, direction: e.target.value as 'up' | 'down' })} aria-label="Direction"><option value="up">breaks above</option><option value="down">breaks below</option></select> the first{' '}
          <select value={c.minutes} onChange={e => onChange({ ...c, minutes: Number(e.target.value) })} aria-label="Range length"><option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>60 min</option></select>
        </>
      );
    case 'vwap':
      return <>close <select value={c.position} onChange={e => onChange({ ...c, position: e.target.value as 'above' | 'below' })} aria-label="Position"><option value="above">above</option><option value="below">below</option></select> VWAP</>;
    case 'prevDay':
      return (
        <>
          close <select value={c.position} onChange={e => onChange({ ...c, position: e.target.value as 'above' | 'below' })} aria-label="Position"><option value="above">above</option><option value="below">below</option></select> previous day{' '}
          <select value={c.level} onChange={e => onChange({ ...c, level: e.target.value as 'high' | 'low' | 'close' })} aria-label="Level"><option value="high">high</option><option value="low">low</option><option value="close">close</option></select>
        </>
      );
    case 'vix':
      return <>{opSel(c.op, op => onChange({ ...c, op }))} <NumField value={c.value} onChange={value => onChange({ ...c, value })} step={0.5} min={5} max={90} label="VIX level" /></>;
    case 'signal':
      return <select value={c.direction} onChange={e => onChange({ ...c, direction: e.target.value as 'bull' | 'bear' })} aria-label="Pattern direction"><option value="bull">bullish pattern</option><option value="bear">bearish pattern</option></select>;
  }
}

function ExitRuleFields({ rule, onChange, label }: { rule: ExitRule | null; onChange: (r: ExitRule | null) => void; label: string }) {
  // keep the unit visible when the value is cleared, so the row does not jump back to "none"
  const [unit, setUnit] = useState<string>(rule ? rule.unit : 'none');
  return (
    <span className="lab-inline">
      <select value={unit} aria-label={`${label} unit`} onChange={e => { setUnit(e.target.value); onChange(exitRule(e.target.value, rule ? rule.value : null)); }}>
        <option value="none">none</option><option value="pct">% of premium</option><option value="rupees">rupees</option>
      </select>
      <NumField value={rule ? rule.value : null} min={1} step={1} label={`${label} value`} onChange={v => onChange(exitRule(unit, v))} />
    </span>
  );
}

export function StrategyEditor({ strategy: s, onChange, error, onError }: Props) {
  const [condType, setCondType] = useState<ConditionType>('gap');
  const set = (patch: Partial<Strategy>) => onChange({ ...s, ...patch });
  const setEntry = (patch: Partial<Strategy['entry']>) => set({ entry: { ...s.entry, ...patch } });
  const setExits = (patch: Partial<Strategy['exits']>) => set({ exits: { ...s.exits, ...patch } });
  const setLeg = (i: number, patch: Partial<Leg>) => set({ legs: s.legs.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  const e = s.entry;

  return (
    <>
      <div className="lab-grid2">
        <label className="pt-field pt-field-col"><span className="pt-label">Name</span><input maxLength={40} value={s.name} onChange={ev => set({ name: ev.target.value })} /></label>
        <label className="pt-field pt-field-col"><span className="pt-label">Candles</span>
          <select value={s.interval} onChange={ev => set({ interval: ev.target.value as Interval })}><option value="5m">5 minute</option><option value="15m">15 minute</option></select>
        </label>
      </div>

      <div className="lab-section">Entry</div>
      <div className="lab-grid3">
        <label className="pt-field pt-field-col"><span className="pt-label">Enter from (IST)</span><input type="time" step={300} value={e.window.from} onChange={ev => setEntry({ window: { ...e.window, from: ev.target.value } })} /></label>
        <label className="pt-field pt-field-col"><span className="pt-label">Until</span><input type="time" step={300} value={e.window.to} onChange={ev => setEntry({ window: { ...e.window, to: ev.target.value } })} /></label>
        <label className="pt-field pt-field-col"><span className="pt-label">Trades a day (max)</span><input type="number" min={1} max={5} step={1} value={e.maxTradesPerDay} onChange={ev => setEntry({ maxTradesPerDay: Number(ev.target.value) })} /></label>
      </div>
      <div className="lab-days">
        {DAYS.map((d, i) => (
          <label className="pt-check" key={d}>
            <input type="checkbox" checked={e.weekdays.includes(i + 1)} onChange={ev => setEntry({ weekdays: ev.target.checked ? [...e.weekdays, i + 1].sort() : e.weekdays.filter(x => x !== i + 1) })} /> {d}
          </label>
        ))}
      </div>
      <div className="pt-label">Conditions (all must hold)</div>
      <div>
        {e.conditions.length ? e.conditions.map((c, i) => (
          <div className="lab-row lab-cond" key={i}>
            <b>{CONDITION_LABELS[c.type]}</b>
            <ConditionFields c={c} onChange={nc => setEntry({ conditions: e.conditions.map((x, k) => (k === i ? nc : x)) })} />
            <button type="button" className="pt-small" aria-label="Remove condition" onClick={() => setEntry({ conditions: e.conditions.filter((_, k) => k !== i) })}>Remove</button>
          </div>
        )) : <div className="empty-note">No conditions: it enters at the first candle of the window every allowed day.</div>}
      </div>
      <div className="pt-form-row">
        <select aria-label="Condition to add" value={condType} onChange={ev => setCondType(ev.target.value as ConditionType)}>
          {CONDITION_ORDER.map(t => <option key={t} value={t}>{CONDITION_LABELS[t]}</option>)}
        </select>
        <button type="button" onClick={() => {
          if (e.conditions.length >= MAX_CONDITIONS) { onError(`At most ${MAX_CONDITIONS} conditions.`); return; }
          onError('');
          setEntry({ conditions: [...e.conditions, defaultCondition(condType)] });
        }}>Add condition</button>
      </div>

      <div className="lab-section">Legs (strikes are 50 points apart; ATM is fixed at entry)</div>
      <div>
        {s.legs.map((l, i) => (
          <div className="lab-row lab-leg" key={i}>
            <select aria-label="Side" value={l.side} onChange={ev => setLeg(i, { side: ev.target.value as Leg['side'] })}><option value="BUY">Buy</option><option value="SELL">Sell</option></select>
            <input type="number" min={1} max={10} step={1} aria-label="Lots" value={l.lots} onChange={ev => setLeg(i, { lots: Number(ev.target.value) })} /> lot
            <select aria-label="Strike" value={l.strikeOffset} onChange={ev => setLeg(i, { strikeOffset: Number(ev.target.value) })}>{OFFSETS.map(o => <option key={o} value={o}>{offsetLabel(o)}</option>)}</select>
            <select aria-label="Option type" value={l.optionType} onChange={ev => setLeg(i, { optionType: ev.target.value as Leg['optionType'] })}><option value="CE">CE</option><option value="PE">PE</option></select>
            <select aria-label="Expiry" value={l.expiry} onChange={ev => setLeg(i, { expiry: ev.target.value as Leg['expiry'] })}><option value="weekly">this week</option><option value="next">next week</option></select>
            {s.legs.length > 1 && <button type="button" className="pt-small" aria-label="Remove leg" onClick={() => set({ legs: s.legs.filter((_, k) => k !== i) })}>Remove</button>}
          </div>
        ))}
      </div>
      <div className="pt-form-row"><button type="button" disabled={s.legs.length >= MAX_LEGS} onClick={() => set({ legs: [...s.legs, newLeg()] })}>Add leg</button></div>

      <div className="lab-section">Exits</div>
      <div className="lab-grid2">
        <div className="pt-field pt-field-col"><span className="pt-label">Stop loss</span><ExitRuleFields label="Stop loss" rule={s.exits.stopLoss} onChange={r => setExits({ stopLoss: r })} /></div>
        <div className="pt-field pt-field-col"><span className="pt-label">Target</span><ExitRuleFields label="Target" rule={s.exits.target} onChange={r => setExits({ target: r })} /></div>
        <label className="pt-field pt-field-col"><span className="pt-label">Exit by (IST, latest 15:25)</span><input type="time" step={300} value={s.exits.exitAt} onChange={ev => setExits({ exitAt: ev.target.value })} /></label>
        <label className="pt-field pt-field-col"><span className="pt-label">Exit if NIFTY moves (points, blank for none)</span><NumField value={s.exits.indexMovePts} min={5} step={5} onChange={v => setExits({ indexMovePts: v })} /></label>
      </div>
      <div className="pt-error" role="alert">{error}</div>
    </>
  );
}
