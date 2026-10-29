// Replays historical candles in time order across symbols, for backtests on real data.
import type { Candle, Feed, MarketSnapshot } from '../types.ts';

export interface ReplayOptions {
  candles: Record<string, Candle[]>;
  candleSeconds: number;
  historySize: number;
  /** Historical candles have no order book, so quotes get this assumed spread around the close. */
  spreadBps: number;
}

export class ReplayFeed implements Feed {
  readonly name = 'replay';
  private readonly opts: ReplayOptions;
  private stopped = false;

  constructor(opts: ReplayOptions) {
    this.opts = opts;
  }

  async run(onSnapshot: (snap: MarketSnapshot) => void): Promise<void> {
    const { candleSeconds, historySize, spreadBps } = this.opts;
    const events = Object.entries(this.opts.candles)
      .flatMap(([symbol, candles]) => candles.map((bar, i) => ({ symbol, bar, i, candles })))
      .sort((a, b) => a.bar.time - b.bar.time || a.symbol.localeCompare(b.symbol));

    let n = 0;
    for (const { symbol, bar, i, candles } of events) {
      if (this.stopped) break;
      const closeTime = bar.time + candleSeconds;
      const half = (bar.close * spreadBps) / 2 / 10_000;
      onSnapshot({
        symbol,
        time: closeTime,
        candles: candles.slice(Math.max(0, i + 1 - historySize), i + 1),
        quote: { symbol, bid: bar.close - half, ask: bar.close + half, time: closeTime },
        newCandle: true,
        bar,
      });
      if (++n % 1000 === 0) await new Promise((r) => setImmediate(r));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
