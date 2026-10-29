import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fetchCandles, fetchQuote } from '../src/feeds/coinbase.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(body: unknown, check?: (url: string) => void): void {
  globalThis.fetch = (async (url: string | URL) => {
    check?.(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

test('candles: parses [time, low, high, open, close, volume] rows and sorts oldest first', async () => {
  mockFetch(
    [
      [1700000300, 99, 102, 100, 101, 12.5],
      [1700000000, 98, 101, 99, 100, 10],
    ],
    (url) => assert.match(url, /\/products\/BTC-USD\/candles\?granularity=300/),
  );
  const candles = await fetchCandles('BTC-USD', 300);
  assert.deepEqual(candles[0], { time: 1700000000, low: 98, high: 101, open: 99, close: 100, volume: 10 });
  assert.equal(candles[1]!.close, 101);
});

test('ticker: parses string bid/ask and ISO time', async () => {
  mockFetch({ ask: '68001.5', bid: '68000.25', price: '68001', size: '0.01', volume: '1234', trade_id: 1, time: '2026-10-29T10:00:00.123Z' });
  const q = await fetchQuote('BTC-USD');
  assert.deepEqual(q, { symbol: 'BTC-USD', bid: 68000.25, ask: 68001.5, time: Math.floor(Date.parse('2026-10-29T10:00:00.123Z') / 1000) });
});

test('HTTP errors surface with status and path', async () => {
  globalThis.fetch = (async () => new Response('{"message":"NotFound"}', { status: 404, statusText: 'Not Found' })) as typeof fetch;
  await assert.rejects(fetchQuote('NOPE-USD'), /Coinbase 404 Not Found for \/products\/NOPE-USD\/ticker/);
});
