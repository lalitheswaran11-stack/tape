/**
 * localStorage persistence for the watchlist and the blotter. Everything
 * loaded is shape-validated — a corrupt or foreign value degrades to the
 * empty/unseeded state, never to a crash.
 */

import type { Order, OrderSide, OrderStatus } from './types';

const WATCHLIST_KEY = 'tape-entry.watchlist';
const ORDERS_KEY = 'tape-entry.orders';

/**
 * null = nothing ever persisted (seed the default watchlist from the
 * stream once ids arrive); [] = the user deliberately emptied it.
 */
export function loadWatchlist(): string[] | null {
  try {
    const raw = window.localStorage.getItem(WATCHLIST_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    return null;
  }
}

export function saveWatchlist(symbols: readonly string[]): void {
  try {
    window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(symbols));
  } catch {
    /* storage unavailable — the list simply does not persist */
  }
}

const SIDES: readonly OrderSide[] = ['buy', 'sell'];
const STATUSES: readonly OrderStatus[] = ['working', 'filled', 'cancelled'];

function isOrder(value: unknown): value is Order {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.createdAt === 'number' &&
    typeof o.symbol === 'string' &&
    SIDES.includes(o.side as OrderSide) &&
    typeof o.qty === 'number' &&
    typeof o.limit === 'number' &&
    STATUSES.includes(o.status as OrderStatus) &&
    (o.fillPrice === undefined || typeof o.fillPrice === 'number') &&
    (o.fillTs === undefined || typeof o.fillTs === 'number')
  );
}

export function loadOrders(): Order[] {
  try {
    const raw = window.localStorage.getItem(ORDERS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOrder);
  } catch {
    return [];
  }
}

export function saveOrders(orders: readonly Order[]): void {
  try {
    window.localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  } catch {
    /* storage unavailable — orders simply do not persist */
  }
}
