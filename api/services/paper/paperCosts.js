// Charges on NSE index options, billed the way a discount broker bills them, for the paper trading engine.
//
// Rates checked on 2026-10-28. They change by budget or exchange circular, so they live in one place:
//  - STT 0.15% of premium on the sell side, and 0.15% of intrinsic value on an exercised long option (Union Budget
//    2026-27, from 1 April 2026; it was 0.1% and 0.125% before)
//  - NSE transaction charge 0.03503% of premium (from 1 October 2024)
//  - SEBI turnover fee Rs 10 per crore of premium
//  - stamp duty 0.003% of premium on the buy side
//  - GST 18% on brokerage, exchange and SEBI charges
//  - brokerage a flat Rs 20 per executed order (typical discount broker; set to 0 to ignore it)
// NSE's investor protection fund charge (a few paise per lakh) is left out.

const RATES = {
  brokeragePerOrder: 20,
  sttSellPct: 0.0015,
  sttExercisePct: 0.0015,
  exchangePct: 0.0003503,
  sebiPerCrore: 10,
  stampBuyPct: 0.00003,
  gstPct: 0.18
};

const r2 = x => Math.round(x * 100) / 100;

/** Charges for one fill. Returns each component and the total, all in rupees rounded to the paisa. */
function tradeCharges(side, price, qty, rates = RATES) {
  const turnover = price * qty;
  const brokerage = turnover > 0 ? rates.brokeragePerOrder : 0;
  const stt = side === 'SELL' ? turnover * rates.sttSellPct : 0;
  const exchange = turnover * rates.exchangePct;
  const sebi = (turnover * rates.sebiPerCrore) / 1e7;
  const stamp = side === 'BUY' ? turnover * rates.stampBuyPct : 0;
  const gst = (brokerage + exchange + sebi) * rates.gstPct;
  const parts = { brokerage: r2(brokerage), stt: r2(stt), exchange: r2(exchange), sebi: r2(sebi), stamp: r2(stamp), gst: r2(gst) };
  return { ...parts, total: r2(Object.values(parts).reduce((a, b) => a + b, 0)) };
}

/** Charges when a long option expires in the money and is exercised: STT on the intrinsic value only. */
function exerciseCharges(intrinsic, qty, rates = RATES) {
  const stt = r2(intrinsic * qty * rates.sttExercisePct);
  return { brokerage: 0, stt, exchange: 0, sebi: 0, stamp: 0, gst: 0, total: stt };
}

module.exports = { RATES, tradeCharges, exerciseCharges };
