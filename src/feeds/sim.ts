// Synthetic market: random walks with trending/ranging regimes, jumps, and volume that rises
// with the size of the move. Seeded, so a backtest with the same seed is reproducible.
import type { Candle, Feed, MarketSnapshot } from '../types.ts';

export interface SimOptions {
  symbols: string[];
  seed: number;
  candleSeconds: number;
  historySize: number;
  /** Real milliseconds between candles. 0 runs as fast as possible (backtests). */
  intervalMs: number;
  /** Stop after this many candles per symbol. Omit to run until stopped. */
  candles?: number;
  /** Market time of the first emitted candle, unix seconds. */
  startTime?: number;
}

interface Profile {
  price: number;
  /** Per-candle return standard deviation at 60s candles. */
  sigma: number;
  /** Typical per-candle volume in base units at 60s candles. */
  volume: number;
  spreadBps: number;
}

const PROFILES: Record<string, Profile> = {
  'BTC-USD': { price: 68_000, sigma: 0.0011, volume: 25, spreadBps: 1 },
  'ETH-USD': { price: 3_400, sigma: 0.0014, volume: 350, spreadBps: 1.5 },
  'SOL-USD': { price: 160, sigma: 0.002, volume: 6_000, spreadBps: 3 },
  'DOGE-USD': { price: 0.16, sigma: 0.0025, volume: 4_000_000, spreadBps: 5 },
  'AVAX-USD': { price: 32, sigma: 0.0022, volume: 15_000, spreadBps: 5 },
  'LINK-USD': { price: 15, sigma: 0.0021, volume: 25_000, spreadBps: 4 },
};

const REGIMES = [-1, -0.4, 0, 0, 0.4, 1];

interface SymbolState {
  symbol: string;
  profile: Profile;
  sigma: number;
  price: number;
  drift: number;
  history: Candle[];
}

export class SimFeed implements Feed {
  readonly name: string;
  private readonly opts: SimOptions;
  private readonly rand: () => number;
  private intervalMs: number;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(opts: SimOptions) {
    this.opts = opts;
    this.rand = mulberry32(opts.seed);
    this.intervalMs = opts.intervalMs;
    this.name = `sim (seed ${opts.seed})`;
  }

  async run(onSnapshot: (snap: MarketSnapshot) => void): Promise<void> {
    const { candleSeconds, historySize } = this.opts;
    const timeScale = Math.sqrt(candleSeconds / 60);
    const states: SymbolState[] = this.opts.symbols.map((symbol) => {
      const profile = PROFILES[symbol] ?? { price: 100, sigma: 0.002, volume: 10_000, spreadBps: 5 };
      return { symbol, profile, sigma: profile.sigma * timeScale, price: profile.price, drift: 0, history: [] };
    });

    let time = this.opts.startTime ?? Math.floor(Date.now() / 1000 / candleSeconds) * candleSeconds;
    // Warm-up history so indicators are ready on the first emitted candle.
    time -= historySize * candleSeconds;
    for (let i = 0; i < historySize; i++, time += candleSeconds) {
      for (const s of states) s.history.push(this.step(s, time, candleSeconds));
    }

    for (let n = 0; !this.stopped && (this.opts.candles === undefined || n < this.opts.candles); n++, time += candleSeconds) {
      for (const s of states) {
        const bar = this.step(s, time, candleSeconds);
        s.history.push(bar);
        if (s.history.length > historySize) s.history.shift();
        const closeTime = time + candleSeconds;
        const wide = this.rand() < 0.02 ? 4 + this.rand() * 6 : 1;
        const half = (bar.close * s.profile.spreadBps * wide) / 2 / 10_000;
        onSnapshot({
          symbol: s.symbol,
          time: closeTime,
          candles: s.history.slice(),
          quote: { symbol: s.symbol, bid: bar.close - half, ask: bar.close + half, time: closeTime },
          newCandle: true,
          bar,
        });
      }
      if (this.intervalMs > 0) await this.sleep(this.intervalMs);
      else if (n % 500 === 0) await new Promise((r) => setImmediate(r));
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  /** Change the real-time pace; takes effect immediately. `Infinity` pauses. */
  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
    this.wake?.();
  }

  private step(s: SymbolState, time: number, candleSeconds: number): Candle {
    // Regimes last about two hours of market time on average.
    if (this.rand() < candleSeconds / 7_200) s.drift = REGIMES[Math.floor(this.rand() * REGIMES.length)]! * s.sigma * 0.25;
    let r = s.drift + s.sigma * this.normal();
    if (this.rand() < 0.004) r += s.sigma * (3 + this.rand() * 4) * (this.rand() < 0.5 ? -1 : 1);

    const open = s.price;
    const close = open * Math.exp(r);
    const wick = () => Math.abs(this.normal()) * s.sigma * 0.6;
    const high = Math.max(open, close) * Math.exp(wick());
    const low = Math.min(open, close) * Math.exp(-wick());
    const moveSize = Math.abs(r) / s.sigma;
    const volume = s.profile.volume * (candleSeconds / 60) * Math.exp(0.35 * this.normal()) * (0.6 + 0.5 * moveSize);
    s.price = close;
    return { time, open, high, low, close, volume };
  }

  private normal(): number {
    let u = 0;
    while (u === 0) u = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  private async sleep(ms: number): Promise<void> {
    while (this.intervalMs === Infinity && !this.stopped) await this.waitForWake(Infinity);
    if (!this.stopped) await this.waitForWake(Math.min(ms, this.intervalMs));
  }

  private waitForWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, Number.isFinite(ms) ? ms : 2 ** 31 - 1);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
