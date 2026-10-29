// Coinbase Exchange public market data. No API key, no account, read-only.
// https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles
import type { Candle, Feed, MarketSnapshot, Quote } from '../types.ts';

const BASE = 'https://api.exchange.coinbase.com';
const MAX_CANDLES_PER_REQUEST = 300;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'cryptobot-paper/0.1', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Coinbase ${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

/** Candles between `start` and `end` (unix seconds), oldest first. Coinbase returns at most 300. */
export async function fetchCandles(symbol: string, granularity: number, start?: number, end?: number): Promise<Candle[]> {
  const params = new URLSearchParams({ granularity: String(granularity) });
  if (start !== undefined) params.set('start', new Date(start * 1000).toISOString());
  if (end !== undefined) params.set('end', new Date(end * 1000).toISOString());
  const rows = (await getJson(`/products/${symbol}/candles?${params}`)) as number[][];
  // Rows are [time, low, high, open, close, volume], newest first.
  return rows
    .map(([time, low, high, open, close, volume]) => ({ time: time!, low: low!, high: high!, open: open!, close: close!, volume: volume! }))
    .sort((a, b) => a.time - b.time);
}

/** The most recent `count` closed candles, paging backwards 300 at a time. */
export async function fetchHistory(symbol: string, granularity: number, count: number): Promise<Candle[]> {
  const byTime = new Map<number, Candle>();
  let end = Math.floor(Date.now() / 1000 / granularity) * granularity;
  while (byTime.size < count) {
    const start = end - MAX_CANDLES_PER_REQUEST * granularity;
    const page = await fetchCandles(symbol, granularity, start, end);
    if (page.length === 0) break;
    for (const c of page) byTime.set(c.time, c);
    end = start;
    await new Promise((r) => setTimeout(r, 120)); // stay well under the public rate limit
  }
  const now = Date.now() / 1000;
  return [...byTime.values()]
    .filter((c) => c.time + granularity <= now)
    .sort((a, b) => a.time - b.time)
    .slice(-count);
}

export async function fetchQuote(symbol: string): Promise<Quote> {
  const t = (await getJson(`/products/${symbol}/ticker`)) as { bid: string; ask: string; time: string };
  return { symbol, bid: Number(t.bid), ask: Number(t.ask), time: Math.floor(Date.parse(t.time) / 1000) };
}

export interface CoinbaseLiveOptions {
  symbols: string[];
  granularity: number;
  historySize: number;
  pollSeconds: number;
  onError?: (err: Error, symbol: string) => void;
}

/**
 * Polls the ticker every `pollSeconds` (stops and targets are checked against the live bid)
 * and emits `newCandle: true` once per closed candle so the scanner runs on finished bars.
 */
export class CoinbaseLiveFeed implements Feed {
  readonly name = 'coinbase live';
  private readonly opts: CoinbaseLiveOptions;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(opts: CoinbaseLiveOptions) {
    this.opts = opts;
  }

  async run(onSnapshot: (snap: MarketSnapshot) => void): Promise<void> {
    const { symbols, granularity, historySize, pollSeconds } = this.opts;
    const history = new Map<string, Candle[]>();
    for (const symbol of symbols) history.set(symbol, await fetchHistory(symbol, granularity, historySize));

    while (!this.stopped) {
      const now = Math.floor(Date.now() / 1000);
      for (const symbol of symbols) {
        try {
          const candles = history.get(symbol)!;
          let newCandle = false;
          const lastTime = candles.at(-1)?.time ?? now - historySize * granularity;
          if (now >= lastTime + 2 * granularity) {
            const fresh = (await fetchCandles(symbol, granularity, lastTime + granularity, now)).filter(
              (c) => c.time > lastTime && c.time + granularity <= now,
            );
            if (fresh.length) {
              candles.push(...fresh);
              candles.splice(0, Math.max(0, candles.length - historySize));
              newCandle = true;
            }
          }
          const quote = await fetchQuote(symbol);
          onSnapshot({ symbol, time: Math.max(now, quote.time), candles: candles.slice(), quote, newCandle });
        } catch (err) {
          this.opts.onError?.(err as Error, symbol);
        }
        if (this.stopped) break;
      }
      await this.sleep(pollSeconds * 1000);
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}
