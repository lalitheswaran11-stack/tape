/** Shared formatters. Polarity is always carried by TEXT (sign / word); any
 * color applied on top is secondary encoding only. */

const groups = new Intl.NumberFormat('en-US');

export function formatPrice(v: number): string {
  return v.toFixed(2);
}

/** Signed percent: +1.24% / -0.87%. The sign is the primary carrier. */
export function formatSignedPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** Thousands-grouped integer, e.g. 1,234,567. */
export function formatVolume(v: number): string {
  return groups.format(v);
}

/** Secondary tint class to layer over already-signed text. */
export function trendClass(v: number): 'up' | 'down' {
  return v >= 0 ? 'up' : 'down';
}

/** HH:MM:SS.mmm — tape entries are 1 ms apart, so millis matter. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
    d.getMilliseconds(),
    3,
  )}`;
}
