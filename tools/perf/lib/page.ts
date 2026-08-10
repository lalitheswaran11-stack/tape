/**
 * Browser-side instrumentation helpers shared by the scenario suite and the
 * frame-budget run.
 *
 * Everything that must exist BEFORE the app boots (frame probe, state
 * recorder) goes in via addInitScript; everything else is page.evaluate
 * against the instrumentation handle the monitor exposes as
 * `window.__tapeClient`.
 */

import type { Page } from '@playwright/test';
import type { MetricsSnapshot, TapeClient } from '@lalithesh-star/tape-core';

export const MONITOR_URL = 'http://localhost:4401';

/** The connection banner: the app's single role=status element. */
const BANNER_SELECTOR = 'header [role="status"]';

export interface StateEntry {
  state: string;
  /** page performance.now() at the moment the transition was observed. */
  at: number;
}

interface VolumeWatch {
  id: string;
  samples: number[];
  timer: number;
}

declare global {
  interface Window {
    __tapeClient?: TapeClient;
    /** requestAnimationFrame inter-frame deltas (ms). */
    __frames?: number[];
    /** PerformanceObserver longtask durations (ms). */
    __longTasks?: number[];
    /** Whether the longtask entry type is actually observable here. */
    __longTaskSupport?: boolean;
    /** Banner text transitions as painted in the DOM (MutationObserver). */
    __bannerStates?: StateEntry[];
    /**
     * Client-level onStateChange transitions. Superset of the banner log:
     * transitions that happen back-to-back in one task (degraded →
     * connecting inside the heartbeat tick) never paint, but land here.
     */
    __clientStates?: StateEntry[];
    __volumeWatch?: VolumeWatch;
  }
}

// ---------------------------------------------------------------------------
// Error sentries

export interface ErrorSentry {
  errors: string[];
}

/**
 * Register pageerror + console.error listeners at page open. Tests assert
 * `sentry.errors` is empty at the end — an uncaught exception or logged
 * error anywhere in a scenario is a failure.
 */
export function attachErrorSentry(page: Page): ErrorSentry {
  const sentry: ErrorSentry = { errors: [] };
  page.on('pageerror', (err) => {
    sentry.errors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') sentry.errors.push(`console.error: ${msg.text()}`);
  });
  return sentry;
}

// ---------------------------------------------------------------------------
// Probes (must be installed BEFORE navigation)

/**
 * Frame probe: collect requestAnimationFrame inter-frame deltas into
 * window.__frames and PerformanceObserver longtask durations into
 * window.__longTasks. Install via addInitScript, then navigate.
 */
export async function installFrameProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__frames = [];
    window.__longTasks = [];
    let last = -1;
    const loop = (t: number): void => {
      if (last >= 0) window.__frames!.push(t - last);
      last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.__longTaskSupport =
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes.includes('longtask');
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__longTasks!.push(entry.duration);
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // longtask unsupported in this browser: __longTasks stays empty.
      window.__longTaskSupport = false;
    }
  });
}

/** Whether the frame probe could actually observe longtask entries. */
export function readLongTaskSupport(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__longTaskSupport === true);
}

/** Zero the probe arrays — start of a measurement window. */
export async function resetProbes(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__frames !== undefined) window.__frames.length = 0;
    if (window.__longTasks !== undefined) window.__longTasks.length = 0;
  });
}

export function readFrames(page: Page): Promise<number[]> {
  return page.evaluate(() => (window.__frames ?? []).slice());
}

export function readLongTasks(page: Page): Promise<number[]> {
  return page.evaluate(() => (window.__longTasks ?? []).slice());
}

/**
 * State-sequence recorder. Two logs, both deduplicated and timestamped:
 * - __bannerStates: MutationObserver on the connection banner — every state
 *   transition the user could actually SEE.
 * - __clientStates: client.onStateChange — every transition including ones
 *   too fast to paint (the transport sets degraded and immediately begins
 *   reconnecting in the same task, so 'degraded' can never reach the DOM).
 * Install via addInitScript, then navigate.
 */
export async function installStateRecorder(page: Page): Promise<void> {
  await page.addInitScript((bannerSelector: string) => {
    window.__bannerStates = [];
    window.__clientStates = [];
    const push = (log: { state: string; at: number }[], state: string): void => {
      if (state === '') return;
      const lastEntry = log[log.length - 1];
      if (lastEntry !== undefined && lastEntry.state === state) return;
      log.push({ state, at: performance.now() });
    };
    let clientHooked = false;
    let bannerHooked = false;
    const boot = new MutationObserver(() => {
      if (!clientHooked && window.__tapeClient !== undefined) {
        const client = window.__tapeClient;
        push(window.__clientStates!, client.getState());
        client.onStateChange((s) => push(window.__clientStates!, s));
        clientHooked = true;
      }
      if (!bannerHooked) {
        const el = document.querySelector(bannerSelector);
        if (el !== null) {
          push(window.__bannerStates!, (el.textContent ?? '').trim());
          new MutationObserver(() => {
            push(window.__bannerStates!, (el.textContent ?? '').trim());
          }).observe(el, { childList: true, characterData: true, subtree: true });
          bannerHooked = true;
        }
      }
      if (clientHooked && bannerHooked) boot.disconnect();
    });
    boot.observe(document, { childList: true, subtree: true });
  }, BANNER_SELECTOR);
}

export function readBannerStates(page: Page): Promise<StateEntry[]> {
  return page.evaluate(() => (window.__bannerStates ?? []).slice());
}

export function readClientStates(page: Page): Promise<StateEntry[]> {
  return page.evaluate(() => (window.__clientStates ?? []).slice());
}

// ---------------------------------------------------------------------------
// App access

export function metrics(page: Page): Promise<MetricsSnapshot> {
  return page.evaluate(() => {
    const client = window.__tapeClient;
    if (client === undefined) throw new Error('__tapeClient is not installed');
    return client.getMetrics();
  });
}

/** Current connection banner text as painted in the DOM. */
export async function bannerState(page: Page): Promise<string> {
  const text = await page.locator(BANNER_SELECTOR).textContent();
  return (text ?? '').trim();
}

export async function waitForLive(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () =>
      window.__tapeClient !== undefined && window.__tapeClient.getState() === 'live',
    undefined,
    { timeout: timeoutMs },
  );
}

/** Wait until the virtualized grid has rendered at least one data row. */
export async function waitForRows(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForSelector('[data-tape-row]', { timeout: timeoutMs });
}

/** goto + waitForLive + waitForRows. */
export async function openMonitor(page: Page, url: string = MONITOR_URL): Promise<void> {
  await page.goto(url);
  await waitForLive(page);
  await waitForRows(page);
}

export function renderedRowIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-tape-row]')).map(
      (el) => el.getAttribute('data-tape-row') ?? '',
    ),
  );
}

export interface RowSample {
  id: string;
  text: string;
}

/** Snapshot the first rendered row's identity and cell text. */
export async function sampleFirstRow(page: Page): Promise<RowSample> {
  const row = page.locator('[data-tape-row]').first();
  const id = await row.getAttribute('data-tape-row');
  if (id === null) throw new Error('no rendered rows to sample');
  const text = (await row.textContent()) ?? '';
  return { id, text };
}

/**
 * Assert a row's rendered cells change within the timeout — i.e. values
 * are still ticking. At the ci profile each instrument averages ~2 updates
 * per second, so 15s of true silence is a real failure, not bad luck.
 */
export async function expectRowTicking(
  page: Page,
  id: string,
  timeoutMs = 15_000,
): Promise<void> {
  const row = page.locator(`[data-tape-row="${id}"]`);
  const before = (await row.textContent()) ?? '';
  await page.waitForFunction(
    ({ rowId, prev }) => {
      const el = document.querySelector(`[data-tape-row="${rowId}"]`);
      return el !== null && (el.textContent ?? '') !== prev;
    },
    { rowId: id, prev: before },
    { timeout: timeoutMs },
  );
}

// ---------------------------------------------------------------------------
// Volume watcher (gap scenario: monotone accumulate+snapshot semantics)

/**
 * Start sampling one symbol's `volume` straight from the client store
 * (refcounted subscribe with the app's own policy returns the SAME store —
 * exact values, no display rounding). Returns the watched symbol id.
 */
export function startVolumeWatch(page: Page, everyMs = 50): Promise<string> {
  return page.evaluate((intervalMs) => {
    const client = window.__tapeClient;
    if (client === undefined) throw new Error('__tapeClient is not installed');
    const sub = client.subscribe('instruments', { volume: 'accumulate' });
    const firstRow = document.querySelector('[data-tape-row]');
    const id = firstRow?.getAttribute('data-tape-row') ?? sub.store.ids()[0];
    if (id === undefined) throw new Error('no records to watch');
    const samples: number[] = [];
    const timer = window.setInterval(() => {
      const rec = sub.store.get(id);
      if (rec !== undefined && typeof rec.fields.volume === 'number') {
        samples.push(rec.fields.volume);
      }
    }, intervalMs);
    window.__volumeWatch = { id, samples, timer };
    return id;
  }, everyMs);
}

export function stopVolumeWatch(
  page: Page,
): Promise<{ id: string; samples: number[] }> {
  return page.evaluate(() => {
    const watch = window.__volumeWatch;
    if (watch === undefined) throw new Error('volume watch was never started');
    window.clearInterval(watch.timer);
    return { id: watch.id, samples: watch.samples.slice() };
  });
}
