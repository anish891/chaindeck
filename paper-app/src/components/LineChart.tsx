// A small SVG line chart (no chart library): axes, grid, optional zero line, hover crosshair with a tooltip. Colours are CSS
// variables, so the light and dark themes (and the System setting) apply without any redraw logic.

import { useId, useState } from 'react';
import { useWidth } from '../hooks';

export interface Series {
  label: string;
  values: number[];
  /** a CSS colour, normally a theme variable such as var(--accent) */
  color: string;
  dashed?: boolean;
  width?: number;
  /** colour the line green above zero and red below it */
  splitAtZero?: boolean;
}

interface Props {
  xs: (number | string)[];
  series: Series[];
  height?: number;
  yFormat: (v: number) => string;
  xFormat?: (x: number | string) => string;
  zeroLine?: boolean;
  dots?: boolean;
  label: string;
}

const M = { left: 62, right: 12, top: 10, bottom: 24 };

/** Round tick values covering [lo, hi] with roughly `count` steps. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export function LineChart({ xs, series, height = 260, yFormat, xFormat = String, zeroLine = false, dots = false, label }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId();
  const w = Math.max(width, 240);
  const innerW = w - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const n = xs.length;

  const all = series.flatMap(s => s.values).filter(Number.isFinite);
  if (!n || !all.length) return <div ref={ref} className="pt-chart" style={{ height }} />;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.06;
  lo -= pad; hi += pad;
  const numeric = xs.every(x => typeof x === 'number');
  const xNums = numeric ? (xs as number[]) : xs.map((_, i) => i);
  const xLo = xNums[0]!, xHi = xNums[n - 1]!;
  const sx = (i: number) => M.left + (xHi === xLo ? innerW / 2 : ((xNums[i]! - xLo) / (xHi - xLo)) * innerW);
  const sy = (v: number) => M.top + innerH - ((v - lo) / (hi - lo)) * innerH;
  const yTicks = niceTicks(lo, hi, 5);
  const xTickIdx = Array.from(new Set(Array.from({ length: Math.min(n, 7) }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, Math.min(n, 7) - 1)))));
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join('');
  const zeroFrac = Math.min(1, Math.max(0, (hi - 0) / (hi - lo)));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(sx(i) - x); if (d < bestD) { bestD = d; best = i; } }
    setHover(best);
  };

  return (
    <div ref={ref} className="pt-chart" style={{ height }}>
      <svg width={w} height={height} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          {series.filter(s => s.splitAtZero).map(s => (
            <linearGradient key={s.label} id={`${gid}-${s.label}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={M.top} y2={M.top + innerH}>
              <stop offset={zeroFrac} style={{ stopColor: 'var(--bull)' }} />
              <stop offset={zeroFrac} style={{ stopColor: 'var(--bear)' }} />
            </linearGradient>
          ))}
        </defs>
        {yTicks.map(t => (
          <g key={t}>
            <line x1={M.left} x2={w - M.right} y1={sy(t)} y2={sy(t)} style={{ stroke: t === 0 && zeroLine ? 'var(--muted)' : 'var(--border)' }} />
            <text x={M.left - 6} y={sy(t) + 3} textAnchor="end" className="pt-axis">{yFormat(t)}</text>
          </g>
        ))}
        {xTickIdx.map(i => (
          <text key={i} x={sx(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="pt-axis">{xFormat(xs[i]!)}</text>
        ))}
        {series.map(s => (
          <g key={s.label}>
            <path d={path(s.values)} fill="none" strokeWidth={s.width || 2} strokeLinejoin="round" strokeDasharray={s.dashed ? '5 4' : undefined}
              style={{ stroke: s.splitAtZero ? `url(#${gid}-${s.label})` : s.color }} />
            {dots && s.values.map((v, i) => <circle key={i} cx={sx(i)} cy={sy(v)} r={2.5} style={{ fill: s.color }} />)}
          </g>
        ))}
        {hover !== null && (
          <g>
            <line x1={sx(hover)} x2={sx(hover)} y1={M.top} y2={M.top + innerH} style={{ stroke: 'var(--muted)' }} strokeDasharray="3 3" />
            {series.map(s => <circle key={s.label} cx={sx(hover)} cy={sy(s.values[hover]!)} r={3.5} style={{ fill: s.color }} />)}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="pt-tip" aria-hidden="true" style={{ left: Math.min(Math.max(sx(hover) + 10, 4), w - 150) }}>
          <b>{xFormat(xs[hover]!)}</b>
          {series.map(s => <div key={s.label}><span className="pt-tip-dot" style={{ background: s.color }} /> {s.label}: {yFormat(s.values[hover]!)}</div>)}
        </div>
      )}
    </div>
  );
}
