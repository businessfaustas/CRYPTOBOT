import type { Candle, Quote } from './types.ts';

export function mid(q: Quote): number {
  return (q.bid + q.ask) / 2;
}

export function spreadBps(q: Quote): number {
  const m = mid(q);
  return m > 0 ? ((q.ask - q.bid) / m) * 10_000 : Infinity;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Exponential moving average series, seeded with the first value. */
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? NaN;
  for (const v of values) {
    prev = out.length === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's average true range of the last bar. NaN until there is enough history. */
export function atr(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prevClose = candles[i - 1]!.close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  let a = mean(trs.slice(0, period));
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]!) / period;
  return a;
}

export function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return `${sign}$${int!.replace(/\B(?=(\d{3})+$)/g, ',')}.${dec}`;
}

export function fmtPrice(n: number): string {
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

export function fmtQty(n: number): string {
  return Number(n.toPrecision(6)).toString();
}

export function fmtPct(fraction: number, digits = 2): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}
