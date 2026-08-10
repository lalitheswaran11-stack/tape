/**
 * PerfHud — a fixed-position performance overlay, toggled by a key
 * (default: backquote). Cheap by construction: while visible, one rAF loop
 * only counts frame intervals into a ring; a sampleMs cadence (driven by
 * useMetrics' interval) setStates a summary.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { TapeClient } from '@lalitheswaran11-stack/tape-core';
import { useMetrics } from './client-hooks';
import { readRowRenderCount } from './VirtualGrid';

export interface PerfHudProps {
  client: TapeClient;
  /** KeyboardEvent.code (or .key) that toggles the HUD. Default 'Backquote'. */
  toggleKey?: string;
  sampleMs?: number;
  className?: string;
  style?: CSSProperties;
}

interface HudSummary {
  fps: number;
  p95FrameMs: number;
  longestFrameMs: number;
  msgsPerSec: number;
  rowRendersPerSec: number;
  coalesceRatio: number;
  deferredFrames: number;
  staleDropped: number;
  gapsDetected: number;
  reconnects: number;
  p95FlushMs: number;
}

const RING_CAPACITY = 240;

export function PerfHud({
  client,
  toggleKey = 'Backquote',
  sampleMs = 500,
  className,
  style,
}: PerfHudProps) {
  const [visible, setVisible] = useState(false);
  const [summary, setSummary] = useState<HudSummary | null>(null);
  const metrics = useMetrics(client, sampleMs);
  const frameRing = useRef<number[]>([]);
  const prevSample = useRef<{
    t: number;
    messagesIn: number;
    rowRenders: number;
  } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === toggleKey || e.key === toggleKey) setVisible((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleKey]);

  // Frame-interval counter: the only per-frame work is a push into a ring.
  useEffect(() => {
    if (!visible) return;
    frameRing.current = [];
    let last: number | null = null;
    let handle: number | null = null;
    const loop = (now: number) => {
      if (last !== null) {
        const ring = frameRing.current;
        ring.push(now - last);
        if (ring.length > RING_CAPACITY) {
          ring.splice(0, ring.length - RING_CAPACITY);
        }
      }
      last = now;
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);
    return () => {
      if (handle !== null) cancelAnimationFrame(handle);
    };
  }, [visible]);

  // One summary per metrics sample while visible.
  useEffect(() => {
    if (!visible) {
      prevSample.current = null;
      return;
    }
    const t = performance.now();
    const rows = readRowRenderCount();
    const prev = prevSample.current;
    const dtSec =
      prev !== null && t > prev.t ? (t - prev.t) / 1000 : sampleMs / 1000;
    const msgsPerSec =
      prev === null ? 0 : (metrics.messagesIn - prev.messagesIn) / dtSec;
    const rowRendersPerSec =
      prev === null ? 0 : (rows - prev.rowRenders) / dtSec;
    prevSample.current = { t, messagesIn: metrics.messagesIn, rowRenders: rows };

    const ring = frameRing.current;
    let fps = 0;
    let p95 = 0;
    let longest = 0;
    if (ring.length > 0) {
      const sorted = [...ring].sort((a, b) => a - b);
      const avg = ring.reduce((a, b) => a + b, 0) / ring.length;
      fps = avg > 0 ? 1000 / avg : 0;
      p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
      longest = sorted[sorted.length - 1] ?? 0;
    }
    setSummary({
      fps,
      p95FrameMs: p95,
      longestFrameMs: longest,
      msgsPerSec,
      rowRendersPerSec,
      coalesceRatio: metrics.coalesceRatio,
      deferredFrames: metrics.deferredFrames,
      staleDropped: metrics.staleDropped,
      gapsDetected: metrics.gapsDetected,
      reconnects: metrics.reconnects,
      p95FlushMs: metrics.p95FlushMs,
    });
  }, [visible, metrics, sampleMs]);

  if (!visible) return null;

  const lines: Array<[string, string]> =
    summary === null
      ? []
      : [
          ['fps', summary.fps.toFixed(0)],
          ['p95 frame', `${summary.p95FrameMs.toFixed(1)} ms`],
          ['longest', `${summary.longestFrameMs.toFixed(1)} ms`],
          ['msgs/s', summary.msgsPerSec.toFixed(0)],
          ['coalesce', `x${summary.coalesceRatio.toFixed(2)}`],
          ['deferred', String(summary.deferredFrames)],
          ['stale drop', String(summary.staleDropped)],
          ['gaps', String(summary.gapsDetected)],
          ['reconnects', String(summary.reconnects)],
          ['p95 flush', `${summary.p95FlushMs.toFixed(1)} ms`],
          ['row renders/s', summary.rowRendersPerSec.toFixed(0)],
        ];

  return (
    <div
      data-tape-hud=""
      aria-label="performance hud"
      className={className}
      style={{
        position: 'fixed',
        right: 8,
        bottom: 8,
        zIndex: 9999,
        minWidth: 180,
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid var(--tape-border, #21262d)',
        background: 'var(--tape-hud-bg, rgba(1,4,9,0.88))',
        color: 'var(--tape-text, #c9d1d9)',
        font: '11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        fontVariantNumeric: 'tabular-nums',
        pointerEvents: 'none',
        ...style,
      }}
    >
      {lines.map(([label, value]) => (
        <div
          key={label}
          style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}
        >
          <span style={{ color: 'var(--tape-text-dim, #8b949e)' }}>{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}
