// Replay of a past expiry day in the Expiry Day panel: pick a stored expiry, then step (or play) through it in
// 10-minute frames. While a replay is shown, live updates leave the panel alone; choosing "Live" hands it back.
// Data: /api/expiry-replay (series kept 14 days, strike snapshots 7 days, so the last expiry replays in full).
import { fetchExpiryReplay } from './api-client.js';
import { computeExpiryDay, replayInput } from './expiry-day.js';
import { renderExpiryPanel } from './expiry-panel.js';
import { renderExpiryDecayChart } from './charts.js';
import { setIconText } from './icons.js';

const PLAY_STEP_MS = 900;
const FRAME_MIN = 10;

let replay = null; // { expiry, date, points, frames, decayOnly }
let frameIndex = 0;
let playTimer = null;
let daysLoaded = false;
let opts = { lotSize: () => 65, onExit: () => {} };
const $ = id => document.getElementById(id);
const hm = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

export const replayActive = () => replay !== null;

/** Strike snapshots older than 7 days are gone: step through the series alone (decay and max pain still replay). */
function seriesFrames(points) {
  const out = [];
  let lastMark = null;
  points.forEach(p => {
    const mark = Math.floor(p.t / (FRAME_MIN * 60000));
    if (mark !== lastMark) { out.push({ t: p.t, strikes: [] }); lastMark = mark; }
  });
  return out;
}

function setControlsVisible(on) {
  ['replayPrev', 'replayTime', 'replayNext', 'replayPlay'].forEach(id => { const e = $(id); if (e) e.hidden = !on; });
}

function setNote(text) {
  const n = $('replayNote');
  if (n) n.textContent = text;
}

function render() {
  if (!replay) return;
  const input = replayInput(replay, frameIndex, opts.lotSize());
  if (!input) return;
  const x = computeExpiryDay(input.d, input.points, input.nowMs);
  if (x.status === 'ok') {
    x.replay = {
      t: input.nowMs,
      note: replay.decayOnly
        ? 'Strike snapshots for this day have expired (kept 7 days), so only straddle decay and max pain replay.'
        : 'Strike figures are from the saved snapshot; zero gamma and the GEX regime are not saved.'
    };
  }
  renderExpiryPanel({ head: $('expiryDayHead'), decay: $('expiryDecayBody'), pin: $('expiryPinBody'), gamma: $('expiryGammaBody') }, x);
  const series = x.decay && x.decay.series ? x.decay.series : [];
  const wrap = $('expiryDecayChartWrap');
  if (wrap) wrap.hidden = series.length < 2;
  if (series.length >= 2) renderExpiryDecayChart('expiryDecayChart', series);
  const sel = $('replayTime');
  if (sel) sel.value = String(frameIndex);
  const prev = $('replayPrev'), next = $('replayNext');
  if (prev) prev.disabled = frameIndex <= 0;
  if (next) next.disabled = frameIndex >= replay.frames.length - 1;
}

function stopPlay() {
  clearInterval(playTimer);
  playTimer = null;
  setIconText($('replayPlay'), 'play', ' Play');
}

/** Fill the day list once; the panel stays usable (Live only) if storage is off or the request fails. */
export async function loadReplayDays() {
  if (daysLoaded) return;
  daysLoaded = true;
  const sel = $('replayDay');
  if (!sel) return;
  try {
    const { days } = await fetchExpiryReplay();
    (days || []).forEach(d => {
      const o = document.createElement('option');
      o.value = d.expiry;
      o.textContent = `${d.expiry}${d.strikesKept ? '' : ' (decay only)'}`;
      sel.append(o);
    });
    if (!days || !days.length) setNote('No past expiry day is stored yet (the last 14 days are kept).');
  } catch (e) {
    console.error('Expiry replay list failed:', e);
    setNote('Past expiry days could not be loaded.');
  }
}

export function initExpiryReplay(options) {
  opts = { ...opts, ...options };
  setControlsVisible(false);
  setIconText($('replayPrev'), 'chevron-left', '');
  setIconText($('replayNext'), 'chevron-right', '');
  setIconText($('replayPlay'), 'play', ' Play');
}

export async function onReplayDayChange() {
  stopPlay();
  const expiry = $('replayDay') ? $('replayDay').value : '';
  if (!expiry) {
    replay = null;
    setControlsVisible(false);
    setNote('');
    opts.onExit();
    return;
  }
  setNote('Loading...');
  try {
    const data = await fetchExpiryReplay(expiry);
    if (($('replayDay') || {}).value !== expiry) return; // the user picked something else meanwhile
    const points = data.points || [];
    const decayOnly = !(data.frames && data.frames.length);
    const frames = decayOnly ? seriesFrames(points) : data.frames;
    if (!frames.length) { setNote('Nothing was saved for that day.'); return; }
    replay = { expiry: data.expiry, date: data.date, points, frames, decayOnly };
    const sel = $('replayTime');
    if (sel) {
      sel.textContent = '';
      frames.forEach((f, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = hm(f.t);
        sel.append(o);
      });
    }
    frameIndex = 0;
    setControlsVisible(true);
    setNote(`${points.length} snapshots saved that day.`);
    render();
  } catch (e) {
    console.error('Expiry replay failed:', e);
    setNote('That day could not be loaded.');
  }
}

export function onReplayTimeChange() {
  if (!replay) return;
  stopPlay();
  frameIndex = Math.min(replay.frames.length - 1, Math.max(0, Number(($('replayTime') || {}).value) || 0));
  render();
}

export function replayStep(dir) {
  if (!replay) return;
  stopPlay();
  frameIndex = Math.min(replay.frames.length - 1, Math.max(0, frameIndex + (Number(dir) < 0 ? -1 : 1)));
  render();
}

export function replayTogglePlay() {
  if (!replay) return;
  if (playTimer) { stopPlay(); return; }
  if (frameIndex >= replay.frames.length - 1) frameIndex = 0;
  setIconText($('replayPlay'), 'pause', ' Pause');
  render();
  playTimer = setInterval(() => {
    if (!replay || frameIndex >= replay.frames.length - 1) { stopPlay(); return; }
    frameIndex += 1;
    render();
  }, PLAY_STEP_MS);
}
