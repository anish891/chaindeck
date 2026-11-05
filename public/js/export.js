// Export menu: option chain CSV, dashboard snapshot (PNG) and the PDF report. The heavy libraries (html2canvas,
// html2pdf) are vendored and loaded only when the user asks for an export.
import { setIconText } from './icons.js';
import { escapeHtml } from './ui-utils.js';
import { fmt } from './charts.js';
import { chartScreenshot } from './price-chart.js';

let getData = () => null;

/** app.js owns the live data; the exporters read it through this getter when clicked. */
export function initExport(dataGetter) {
  getData = dataGetter;
}

export function exportCSV() {
  const currentData = getData();
  if (!currentData || !currentData.strikes) {
    alert('No data available to export yet!');
    return;
  }

  const headers = [
    'Call_Chg_OI', 'Call_OI', 'Call_IV', 'Call_LTP', 'Call_Bid', 'Call_Ask',
    'Strike',
    'Put_Bid', 'Put_Ask', 'Put_LTP', 'Put_IV', 'Put_OI', 'Put_Chg_OI'
  ];

  const csvRows = [headers.join(',')];

  currentData.strikes.forEach(r => {
    const ce = r.CE || {};
    const pe = r.PE || {};
    const row = [
      ce.changeinOpenInterest || 0,
      ce.openInterest || 0,
      ce.impliedVolatility || 0,
      ce.lastPrice || 0,
      ce.bidprice || 0,
      ce.askPrice || 0,
      r.strike,
      pe.bidprice || 0,
      pe.askPrice || 0,
      pe.lastPrice || 0,
      pe.impliedVolatility || 0,
      pe.openInterest || 0,
      pe.changeinOpenInterest || 0
    ];
    // Numbers only: a spreadsheet would execute a text cell starting with = + - or @ as a formula.
    csvRows.push(row.map(v => (Number.isFinite(Number(v)) ? Number(v) : 0)).join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const filename = `ChainDeck_${currentData.expiry || 'chain'}_${new Date().toISOString().slice(0, 10)}.csv`;
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Load a same-origin script once; rejects (instead of throwing inside a callback) so callers can catch it. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing && existing.dataset.loaded) { resolve(); return; }
    const script = existing || document.createElement('script');
    script.onload = () => { script.dataset.loaded = '1'; resolve(); };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    if (!existing) { script.src = src; document.head.appendChild(script); }
  });
}

export async function takeSnapshot() {
  const btn = document.getElementById('btnSnapshot');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) setIconText(btn, 'loader', 'Capturing...', 'spin');

  const captureWindow = async () => {
    const canvas = await window.html2canvas(document.body, {
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg') || '#0d0f14',
      scrollX: 0,
      scrollY: 0,
      scale: 1.5,
      useCORS: true
    });
    const image = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    const filename = `ChainDeck_Snapshot_${new Date().toISOString().slice(0, 10)}.png`;
    link.download = filename;
    link.href = image;
    link.click();
  };

  try {
    if (typeof window.html2canvas === 'undefined') await loadScript('/vendor/html2canvas.min.js');
    await captureWindow();
  } catch (err) {
    console.error('Snapshot failed:', err);
    alert('Failed to capture snapshot.');
  } finally {
    if (btn) btn.innerHTML = originalHtml; // always reset the button, whatever happened
  }
}

export async function exportPDF() {
  const currentData = getData();
  if (!currentData || !currentData.strikes) {
    alert('No data available to export yet!');
    return;
  }

  const btn = document.getElementById('btnPDF');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) setIconText(btn, 'loader', 'Generating PDF...', 'spin');

  const generatePDF = async () => {
    const reportContainer = buildDashboardReport(currentData);
    // Keep it laid out (so it has a real size) but out of sight, via a wrapper instead of positioning the report itself.
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    // 1074px = A4 landscape printable width, so heights measured here match the layout html2pdf will use
    holder.style.cssText = 'position: fixed; left: -10000px; top: 0; width: 1074px; overflow: hidden; pointer-events: none;';
    holder.appendChild(reportContainer);
    document.body.appendChild(holder);
    markAvoidBreaks(reportContainer);

    try {
      const opt = {
        margin: [0.25, 0.25, 0.25, 0.25],
        filename: `ChainDeck_Report_${new Date().toISOString().slice(0, 10)}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 1.6, useCORS: true, logging: false, backgroundColor: '#ffffff' },
        // Landscape: the dashboard is laid out for a wide screen, so this keeps panels side by side as they appear on screen.
        jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape', compress: true },
        // Keep cards, panels and table rows whole instead of slicing through them ('avoid-all' would leave huge gaps).
        pagebreak: { mode: ['css', 'legacy'], avoid: ['.pdf-avoid', 'img', '.keystrip', '.oi-summary', 'tr'] }
      };

      if (window.html2pdf) {
        await window.html2pdf().set(opt).from(reportContainer).save();
      } else {
        throw new Error('PDF library failed to load');
      }
    } finally {
      holder.remove();
    }
  };

  try {
    if (typeof window.html2pdf === 'undefined') await loadScript('/vendor/html2pdf.bundle.min.js');
    await generatePDF();
  } catch (err) {
    console.error('PDF export failed:', err);
    alert('Failed to export PDF.');
  } finally {
    if (btn) btn.innerHTML = originalHtml;
  }
}

/**
 * Builds the PDF from the live dashboard (every panel, chart and table as shown on screen), so the PDF carries the same
 * information as the Snapshot and new panels are included automatically. Each section is cloned into a print-friendly
 * light-theme container. Things a clone cannot carry over are handled explicitly:
 *   - <canvas> charts clone as blank, so they become <img> snapshots of the original canvas;
 *   - dropdowns become plain text, and buttons / help popovers / the greeks toggle are dropped;
 *   - collapsed "Advanced analytics" is opened; fixed overlays, drawers and the toolbar are skipped.
 * The container is normal-flow and width:100%: html2pdf lays the clone out inside a container as wide as the page,
 * and an absolutely positioned or fixed-width element there gets clipped or collapses to 0px (blank PDF).
 */
const PDF_PAGE_PX = 746; // printable page height in CSS px at the report width (A4 landscape, 0.25in margins)

/**
 * html2pdf can keep chosen elements from being sliced by a page break, but only via selectors. The dashboard's cards
 * are a mix of classes and inline-styled boxes, so tag them by how they look instead: any rounded box that is bordered
 * or filled and no more than 60% of a page tall (larger containers may break between their inner cards). Must run while the report is attached and laid out at the page width.
 */
function markAvoidBreaks(root) {
  root.querySelectorAll('div, details, table').forEach(el => {
    const h = el.getBoundingClientRect().height;
    if (h < 24) return;
    const cs = getComputedStyle(el);
    // A grid's items cannot be held back one at a time (the page-break spacer becomes a grid cell and shifts the layout
    // instead of moving the card), so keep a whole grid together whenever it fits on one page.
    if (cs.display === 'grid' && h <= PDF_PAGE_PX * 0.95) { el.classList.add('pdf-avoid'); return; }
    if (h > PDF_PAGE_PX * 0.6) return; // bigger containers may split between their inner cards
    const rounded = parseFloat(cs.borderTopLeftRadius) > 0;
    const bordered = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    const filled = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    if (rounded && (bordered || filled)) el.classList.add('pdf-avoid');
  });
}

function buildDashboardReport(d) {
  const root = document.createElement('div');
  root.className = 'pdf-export-report';
  root.setAttribute('data-theme', 'light'); // scopes the light palette to the report, whatever theme the page is in

  const dateStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const head = document.createElement('div');
  head.className = 'pdf-report-head';
  head.innerHTML = `
    <div>
      <h1>Chain<span>Deck</span> Analytics Report</h1>
      <div class="pdf-report-sub">Generated: <strong>${escapeHtml(dateStr)} IST</strong> | Expiry: <strong>${escapeHtml(d.expiry || 'n/a')}</strong> | Data sourced from Upstox. For analytical purposes only.</div>
    </div>
    <div class="pdf-report-spot">
      <div>Spot: ${escapeHtml(fmt(d.spot))}</div>
      <div class="pdf-report-sub">ATM Strike: ${escapeHtml(fmt(d.atm))}</div>
    </div>`;
  root.appendChild(head);

  let previous = null;
  [...document.body.children].forEach(node => {
    if (node.tagName === 'SCRIPT' || node.classList.contains('topbar')) return;
    if (getComputedStyle(node).position === 'fixed') return; // overlay, drawers, toasts, footer, popovers
    const clone = node.cloneNode(true);
    // the option chain (heading + table) reads best starting on a fresh page, and keeps its heading with the table
    if (node.classList.contains('table-wrap') && previous) {
      previous.style.pageBreakBefore = 'always';
      previous.style.breakBefore = 'page';
    }

    // charts: a cloned <canvas> is blank, so swap in an image of the real one
    const sources = node.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((cv, i) => {
      const src = sources[i];
      if (!src || !src.width || !src.height || src.closest('#priceChart')) { cv.remove(); return; } // the price chart is handled below
      const img = document.createElement('img');
      img.src = src.toDataURL('image/png');
      img.alt = '';
      img.style.cssText = `display: block; width: 100%; height: ${src.clientHeight || src.height}px;`;
      cv.replaceWith(img);
    });

    // the price chart is several stacked canvases (and a logo link), so it is captured with the library's own screenshot
    const chartHost = clone.querySelector('#priceChart');
    if (chartHost) {
      const shot = chartScreenshot();
      if (shot) {
        const img = document.createElement('img');
        img.src = shot.src;
        img.alt = '';
        img.style.cssText = `display: block; width: 100%; aspect-ratio: ${shot.width} / ${shot.height};`;
        chartHost.replaceWith(img);
      } else {
        chartHost.remove();
      }
    }

    // dropdowns keep their current value as text; controls are not useful on paper
    clone.querySelectorAll('select').forEach(sel => {
      const span = document.createElement('span');
      span.className = 'pdf-select-value';
      span.textContent = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '';
      sel.replaceWith(span);
    });
    clone.querySelectorAll('input').forEach(inp => (inp.closest('label') || inp).remove());
    clone.querySelectorAll('button, textarea').forEach(el => el.remove());
    clone.querySelectorAll('details').forEach(el => { el.open = true; });
    if (clone.tagName === 'DETAILS') clone.open = true;
    root.appendChild(clone);
    previous = clone;
  });

  return root;
}

// Dropdown Menu Handlers
/**
 * The menu is right-aligned under its button, but on narrow screens the toolbar wraps and the button can sit at the
 * left edge, which pushed the menu partly off-screen (its icons and the start of every label were clipped).
 * Measure it once open and slide it back inside the viewport.
 */
function placeExportMenu() {
  const dd = document.getElementById('exportDropdown');
  const menu = document.getElementById('exportMenu');
  if (!dd || !menu || !dd.classList.contains('active')) return;
  menu.style.left = '';
  menu.style.right = ''; // back to the default right-aligned position before measuring
  const margin = 8;
  const m = menu.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - margin - m.width);
  const wanted = Math.min(Math.max(m.left, margin), maxLeft);
  if (Math.abs(wanted - m.left) > 0.5) {
    menu.style.right = 'auto';
    menu.style.left = `${wanted - dd.getBoundingClientRect().left}px`;
  }
}

export function toggleExportMenu(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('exportDropdown');
  if (!dd) return;
  dd.classList.toggle('active');
  placeExportMenu();
}

// A resize (rotation, window drag) can change where the button sits: re-clamp instead of leaving it misplaced.
window.addEventListener('resize', placeExportMenu);

export function closeExportMenu() {
  const dd = document.getElementById('exportDropdown');
  if (dd) dd.classList.remove('active');
}

document.addEventListener('click', (e) => {
  const dd = document.getElementById('exportDropdown');
  if (dd && !dd.contains(e.target)) {
    dd.classList.remove('active');
  }
});
