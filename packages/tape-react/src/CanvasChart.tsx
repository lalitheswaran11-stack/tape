/**
 * CanvasChart — Canvas 2D chart of one record field.
 *
 * Data path: subscribe to store.onFlush; when the watched record changed,
 * push { t: record.ts, v: fields[field] } into a bounded ring. Rendering
 * path: ONE draw per requestAnimationFrame and only when dirty — per-tick
 * DOM/draw work is exactly what this component exists to avoid.
 *
 * DPR: the backing store is sized cssPixels * devicePixelRatio and the
 * context scaled by dpr once per resize (ResizeObserver) — without this the
 * chart is soft on retina displays.
 *
 * Chart rules: single series, one y-axis, recessive grid, min/max and all
 * other labels in the text color (never the series color), a direct
 * current-value label at the line's right end, crosshair + tooltip on
 * pointermove drawn in the same canvas pass, no legend.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { TapeRecord } from '@lalithesh-star/tape-core';
import type { Stream } from './stream';
import { useStreamStore } from './stream';

export interface ChartColors {
  line?: string;
  up?: string;
  down?: string;
  grid?: string;
  text?: string;
}

const DEFAULT_COLORS: Required<ChartColors> = {
  line: '#58a6ff',
  up: '#3fb950',
  down: '#f85149',
  grid: 'rgba(139,148,158,0.15)',
  text: '#8b949e',
};

export interface CanvasChartProps {
  stream: Stream;
  recordId: string;
  field: string;
  maxPoints?: number;
  height?: number;
  colors?: ChartColors;
  className?: string;
  style?: CSSProperties;
}

interface Point {
  t: number;
  v: number;
}

function formatValue(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
}

function formatTime(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function CanvasChart(props: CanvasChartProps) {
  const {
    stream,
    recordId,
    field,
    maxPoints = 600,
    height = 160,
    colors,
    className,
    style,
  } = props;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Point[]>([]);
  const hoverXRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const palette = { ...DEFAULT_COLORS, ...colors };
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  const store = useStreamStore(stream);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const { w, h } = sizeRef.current;
    if (w <= 0 || h <= 0) return;
    const c = paletteRef.current;

    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    const pts = pointsRef.current;
    if (pts.length === 0) {
      ctx.fillStyle = c.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('no data', w / 2, h / 2);
      return;
    }

    const padL = 8;
    const padR = 56;
    const padT = 10;
    const padB = 16;
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, h - padT - padB);

    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    }
    if (min === max) {
      min -= 0.5;
      max += 0.5;
    }
    const x = (i: number) =>
      pts.length === 1 ? padL + plotW : padL + (i / (pts.length - 1)) * plotW;
    const y = (v: number) => padT + (1 - (v - min) / (max - min)) * plotH;

    // Recessive grid: 4 light horizontal lines.
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 0; g < 4; g++) {
      const gy = padT + (g / 3) * plotH;
      ctx.moveTo(padL, gy);
      ctx.lineTo(padL + plotW, gy);
    }
    ctx.stroke();

    // min/max labels — text color, never the series color.
    ctx.fillStyle = c.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(formatValue(max), padL + 2, padT + 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatValue(min), padL + 2, padT + plotH - 2);

    // The series line.
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = x(i);
      const py = y(pts[i]!.v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Current point: direction-colored dot, value label in text color.
    const lastI = pts.length - 1;
    const lastP = pts[lastI]!;
    const prevP = pts[lastI - 1];
    ctx.fillStyle = prevP === undefined || lastP.v >= prevP.v ? c.up : c.down;
    ctx.beginPath();
    ctx.arc(x(lastI), y(lastP.v), 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatValue(lastP.v), padL + plotW + 6, y(lastP.v));

    // Crosshair + tooltip (same canvas pass).
    const hover = hoverXRef.current;
    if (hover !== null) {
      let nearest = 0;
      let best = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(x(i) - hover);
        if (d < best) {
          best = d;
          nearest = i;
        }
      }
      const hp = pts[nearest]!;
      const hx = x(nearest);
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = c.text;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();
      ctx.restore();
      const label = `${formatValue(hp.v)}  ${formatTime(hp.t)}`;
      const tw = ctx.measureText(label).width;
      const lx = Math.min(Math.max(padL, hx + 6), padL + plotW - tw - 4);
      const ly = padT + 4;
      ctx.fillStyle = 'rgba(1,4,9,0.8)';
      ctx.fillRect(lx - 3, ly - 3, tw + 6, 16);
      ctx.fillStyle = c.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, lx, ly);
      ctx.fillStyle = c.text;
      ctx.beginPath();
      ctx.arc(hx, y(hp.v), 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }, []);

  const scheduleDraw = useCallback(() => {
    dirtyRef.current = true;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      draw();
    });
  }, [draw]);

  // Measure CSS size with ResizeObserver.
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Size the backing store to cssPixels * dpr; scale once per resize.
  // (Setting canvas.width resets the context transform, so the scale here
  // is the only one in effect.)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || size.w <= 0 || size.h <= 0) return;
    const dpr =
      (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = Math.max(1, Math.round(size.w * dpr));
    canvas.height = Math.max(1, Math.round(size.h * dpr));
    const ctx = canvas.getContext('2d');
    if (ctx !== null) ctx.scale(dpr, dpr);
    scheduleDraw();
  }, [size, scheduleDraw]);

  // Data: seed from the current record, then follow flushes.
  useEffect(() => {
    pointsRef.current = [];
    if (store === null) {
      scheduleDraw();
      return;
    }
    const push = (rec: TapeRecord) => {
      const v = rec.fields[field];
      if (typeof v !== 'number') return;
      const pts = pointsRef.current;
      pts.push({ t: rec.ts, v });
      if (pts.length > maxPoints) pts.splice(0, pts.length - maxPoints);
      scheduleDraw();
    };
    const initial = store.get(recordId);
    if (initial !== undefined) push(initial);
    scheduleDraw();
    return store.onFlush((changed) => {
      if (!changed.has(recordId)) return;
      const rec = store.get(recordId);
      if (rec !== undefined) push(rec);
    });
  }, [store, recordId, field, maxPoints, scheduleDraw]);

  // Cancel any pending frame on unmount.
  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      hoverXRef.current = e.clientX - rect.left;
      scheduleDraw();
    },
    [scheduleDraw],
  );

  const onPointerLeave = useCallback(() => {
    hoverXRef.current = null;
    scheduleDraw();
  }, [scheduleDraw]);

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height,
        background: 'var(--tape-bg, #0d1117)',
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block',
        }}
      />
    </div>
  );
}
