// Equity: balance and curve, updated on every snapshot.
import type { ClosedTrade } from '../types.ts';

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface EquityStats {
  start: number;
  current: number;
  returnPct: number;
  maxDrawdownPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Gross profit / gross loss. Infinity with no losing trades. */
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  fees: number;
  avgSlippageBps: number;
}

const MAX_POINTS = 2000;

export class EquityTracker {
  readonly start: number;
  points: EquityPoint[] = [];
  private peak: number;
  private maxDrawdown = 0;

  constructor(start: number) {
    this.start = start;
    this.peak = start;
  }

  record(time: number, equity: number): void {
    const last = this.points.at(-1);
    if (last && last.time === time) last.equity = equity;
    else this.points.push({ time, equity });
    if (this.points.length > MAX_POINTS) this.points = this.points.filter((_, i) => i % 2 === 0 || i === this.points.length - 1);

    this.peak = Math.max(this.peak, equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, (this.peak - equity) / this.peak);
  }

  stats(closed: ClosedTrade[]): EquityStats {
    const current = this.points.at(-1)?.equity ?? this.start;
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
    const slippages = closed.flatMap((t) => [t.entrySlippageBps, t.exitSlippageBps]);
    return {
      start: this.start,
      current,
      returnPct: (current - this.start) / this.start,
      maxDrawdownPct: this.maxDrawdown,
      trades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      fees: closed.reduce((s, t) => s + t.entryFee + t.exitFee, 0),
      avgSlippageBps: slippages.length ? slippages.reduce((s, x) => s + x, 0) / slippages.length : 0,
    };
  }

  /** Evenly spaced subset for charts. */
  sample(n: number): EquityPoint[] {
    if (this.points.length <= n) return this.points;
    const step = (this.points.length - 1) / (n - 1);
    return Array.from({ length: n }, (_, i) => this.points[Math.round(i * step)]!);
  }
}
