// The trust light (top bar), the warning banner, per-card "unverified" tags and the data-checks drawer.
// DOM built with textContent only: check details contain values from the network.
import { announcePanelOpen, onOtherPanelOpen } from './ui-utils.js';
import { CHECK_TARGETS } from './data-checks.js';

const STATUS_TEXT = { ok: 'Data verified', warn: 'Data warnings', bad: 'Data problem' };
const LEVEL_TEXT = { pass: 'Passed', warn: 'Warning', fail: 'Failed', skip: 'Not checked' };

let drawer = null;
let backdrop = null;
let last = null;
let tagged = new Set();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ensureDrawer() {
  if (drawer) return;
  backdrop = el('div', 'trust-backdrop');
  backdrop.dataset.click = 'toggleTrustDrawer:close';
  drawer = el('aside', 'trust-drawer');
  drawer.id = 'trustDrawer';
  drawer.setAttribute('aria-hidden', 'true');
  drawer.setAttribute('aria-label', 'Data checks');
  document.body.append(backdrop, drawer);
  onOtherPanelOpen('trust', () => toggleTrustDrawer('close'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('open')) toggleTrustDrawer('close'); });
}

function counts(summary) {
  const parts = [`${summary.pass} passed`];
  if (summary.warn) parts.push(`${summary.warn} warning${summary.warn > 1 ? 's' : ''}`);
  if (summary.fail) parts.push(`${summary.fail} failed`);
  if (summary.skip) parts.push(`${summary.skip} not checked`);
  return parts.join(', ');
}

function renderDrawer() {
  if (!drawer || !last) return;
  drawer.textContent = '';
  const head = el('div', 'trust-head');
  head.append(el('strong', '', 'Data checks'));
  const close = el('button', 'trust-close', 'Close');
  close.type = 'button';
  close.dataset.click = 'toggleTrustDrawer:close';
  head.append(close);
  drawer.append(head);

  const sum = el('div', `trust-summary ${last.status}`);
  sum.append(el('div', 'trust-summary-title', STATUS_TEXT[last.status]), el('div', 'trust-summary-sub', counts(last.summary)));
  drawer.append(sum);
  if (last.blocking) drawer.append(el('div', 'trust-blocking', 'Signals, alerts and the live record are paused until these clear.'));

  const groups = [];
  last.checks.forEach(c => {
    let g = groups.find(x => x.name === c.group);
    if (!g) { g = { name: c.group, items: [] }; groups.push(g); }
    g.items.push(c);
  });
  const body = el('div', 'trust-body');
  groups.forEach(g => {
    body.append(el('div', 'trust-group', g.name));
    g.items.forEach(c => {
      const row = el('div', `trust-row ${c.level}`);
      row.append(el('i', 'trust-mark'));
      const text = el('div', 'trust-row-text');
      text.append(el('div', 'trust-row-label', c.label), el('div', 'trust-row-detail', `${LEVEL_TEXT[c.level]}: ${c.detail}`));
      row.append(text);
      body.append(row);
    });
  });
  drawer.append(body);
  drawer.append(el('div', 'trust-note', 'These checks show the numbers are fresh, agree with a second source and are internally consistent (PCR, OI totals, max pain and put-call parity are recomputed from the raw NSE data with separate code). They cannot prove NSE itself is right. Yahoo is delayed and unofficial, so its comparison allows a small gap.'));
}

export function toggleTrustDrawer(arg) {
  ensureDrawer();
  const open = arg === 'close' ? false : arg === 'open' ? true : !drawer.classList.contains('open');
  drawer.classList.toggle('open', open);
  backdrop.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  if (open) { announcePanelOpen('trust'); renderDrawer(); }
}

function tagCards(flags) {
  tagged.forEach(card => { card.classList.remove('unverified'); card.removeAttribute('data-unverified'); });
  tagged = new Set();
  for (const [id, level] of Object.entries(flags)) {
    for (const target of CHECK_TARGETS[id] || []) {
      const node = document.getElementById(target);
      const card = node && node.closest('.dashboard-card, .glance-card, .ks-item, .metric-item');
      if (!card) continue;
      card.classList.add('unverified');
      card.dataset.unverified = level === 'fail' ? 'Unverified: a data check failed' : 'Check warning';
      card.title = card.dataset.unverified;
      tagged.add(card);
    }
  }
}

/** Apply a trust result to the page. Cheap enough to call every second; only touches the DOM for what changed. */
export function renderTrust(result) {
  const sig = JSON.stringify([result.status, result.blocking, result.checks.map(c => c.level + c.detail)]);
  const changed = !last || last.__sig !== sig;
  last = { ...result, __sig: sig };

  const btn = document.getElementById('trustBtn');
  if (btn) {
    btn.className = `trust-btn ${result.status}`;
    const text = document.getElementById('trustText');
    const label = result.status === 'ok' ? 'Verified' : result.status === 'warn' ? `${result.summary.warn} warning${result.summary.warn > 1 ? 's' : ''}` : `${result.summary.fail} failing`;
    if (text && text.textContent !== label) text.textContent = label;
    btn.setAttribute('aria-label', `${STATUS_TEXT[result.status]}: ${counts(result.summary)}. Open data checks.`);
  }
  document.body.dataset.trust = result.status;

  const banner = document.getElementById('trustBanner');
  if (banner) {
    const show = result.status !== 'ok' && (result.blocking || result.status === 'bad');
    banner.hidden = !show;
    if (show) {
      const msg = result.blocking
        ? `Some numbers may not match the market. Signals and alerts are paused. ${result.reasons[0] || ''}`
        : `A data check is failing. ${result.checks.find(c => c.level === 'fail').label}: ${result.checks.find(c => c.level === 'fail').detail}`;
      if (banner.textContent !== msg) banner.textContent = msg;
    }
  }
  if (changed) tagCards(result.flags);
  if (drawer && drawer.classList.contains('open')) renderDrawer();
}
