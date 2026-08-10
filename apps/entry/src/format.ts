/** Formatting helpers. Polarity is always signed TEXT first; tint second. */

export function fmtPrice(n: number): string {
  return n.toFixed(2);
}

/** Signed text: "+1.23%" / "-0.45%" / "0.00%". */
export function fmtSignedPct(n: number): string {
  const s = n.toFixed(2);
  return n > 0 ? `+${s}%` : `${s}%`;
}

/** Tint class reinforcing an already-signed value. Zero stays neutral. */
export function polarityClass(n: number): string {
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return '';
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
