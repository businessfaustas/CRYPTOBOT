import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../src/config.ts';
import { exitTrigger, simulateFill, trail } from '../src/agents/executor.ts';
import { riskCheck, type RiskContext } from '../src/agents/riskCheck.ts';
import { scan } from '../src/agents/scanner.ts';
import { size } from '../src/agents/sizer.ts';
import { atr, ema, fmtUsd } from '../src/market.ts';
import type { Candle, MarketSnapshot, Position, Signal } from '../src/types.ts';

const cfg = defaultConfig;

function flatCandles(n: number, price = 100, volume = 1000): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ time: i * 300, open: price, high: price * 1.002, low: price * 0.998, close: price, volume }));
}

function snapshot(candles: Candle[], spreadBps = 2): MarketSnapshot {
  const last = candles.at(-1)!;
  const half = (last.close * spreadBps) / 2 / 10_000;
  const time = last.time + 300;
  return { symbol: 'TEST-USD', time, candles, newCandle: true, quote: { symbol: 'TEST-USD', bid: last.close - half, ask: last.close + half, time } };
}

const signal: Signal = { symbol: 'TEST-USD', time: 0, price: 100, atr: 0.5, strength: 0.8, reason: 'test breakout' };
const ctx: RiskContext = { holding: false, openPositions: 0, killSwitch: false, cooldownUntil: undefined, roundTripFeeBps: 50, rewardPct: 0.02 };

test('ema and atr', () => {
  assert.deepEqual(ema([1, 1, 1], 3), [1, 1, 1]);
  assert.equal(ema([0, 10], 3).at(-1), 5);
  assert.ok(Number.isNaN(atr(flatCandles(5), 14)));
  assert.ok(Math.abs(atr(flatCandles(30), 14) - 0.4) < 1e-9);
});

test('fmtUsd groups thousands', () => {
  assert.equal(fmtUsd(1234567.891), '$1,234,567.89');
  assert.equal(fmtUsd(-44.82), '-$44.82');
});

test('scanner flags a volume breakout in an uptrend and nothing on a flat tape', () => {
  const flat = flatCandles(80);
  assert.equal(scan(snapshot(flat), cfg.scanner).signal, null);

  const trending = flat.map((c, i) => ({ ...c, open: 100 + i * 0.05, close: 100 + i * 0.05, high: 100 + i * 0.05 + 0.1, low: 100 + i * 0.05 - 0.1 }));
  const last = trending.at(-1)!;
  trending.push({ time: last.time + 300, open: last.close, high: last.close + 2, low: last.close, close: last.close + 1.8, volume: 5000 });
  const result = scan(snapshot(trending), cfg.scanner);
  assert.ok(result.signal, result.note);
  assert.match(result.signal.reason, /broke 20-bar high/);
});

test('risk check passes a clean setup and lists every failure otherwise', () => {
  const snap = snapshot(flatCandles(80));
  assert.equal(riskCheck(signal, snap, ctx, cfg.risk).pass, true);

  const bad = riskCheck(signal, snapshot(flatCandles(80), 50), { ...ctx, holding: true, killSwitch: true, openPositions: 3 }, cfg.risk);
  assert.equal(bad.pass, false);
  assert.equal(bad.failures.length, 5); // kill switch, holding, max positions, spread, cost
});

test('risk check rejects trades whose target does not cover costs', () => {
  const res = riskCheck(signal, snapshot(flatCandles(80)), { ...ctx, rewardPct: 0.005 }, cfg.risk);
  assert.equal(res.pass, false);
  assert.match(res.failures[0]!, /round-trip cost/);
});

test('sizer risks a fixed fraction of equity and respects caps', () => {
  // Stop is 2 ATR = $1 below entry; 1% of $1000 = $10 risk → 10 units = $1000 notional, capped at 25% = $250.
  const capped = size(signal, 1000, 1000, cfg.sizer, cfg.executor);
  assert.ok(capped.ok);
  assert.ok(Math.abs(capped.notional - 250) < 1e-9);
  assert.match(capped.reason, /25% cap/);

  const wide = size({ ...signal, atr: 5 }, 1000, 1000, cfg.sizer, cfg.executor);
  assert.ok(wide.ok);
  assert.ok(Math.abs(wide.riskDollars - 10) < 1e-9, 'loses exactly 1% of equity at the stop');

  const broke = size(signal, 1000, 2, cfg.sizer, cfg.executor);
  assert.equal(broke.ok, false);
});

test('executor charges half spread + impact + fee and cancels entries over the slippage cap', () => {
  const small = simulateFill('buy', 1, 100, 4, 1_000_000, cfg.executor);
  assert.ok(small.ok);
  assert.ok(small.fill.price > 100);
  assert.ok(Math.abs(small.fill.slippageBps - 2) < 0.01);
  assert.ok(Math.abs(small.fill.fee - (small.fill.notional * cfg.executor.feeBps) / 10_000) < 1e-12);

  const huge = simulateFill('buy', 100, 100, 4, 1000, cfg.executor);
  assert.equal(huge.ok, false);
  const forcedExit = simulateFill('sell', 100, 100, 4, 1000, cfg.executor);
  assert.ok(forcedExit.ok && forcedExit.fill.price < 100, 'exits always fill');
});

test('exits: stop beats target on the same bar, gaps fill at the open, trailing only ratchets up', () => {
  const pos: Position = {
    id: 1, symbol: 'TEST-USD', qty: 1, entryPrice: 100, entryTime: 0, entryFee: 0, entrySlippageBps: 0,
    atr: 1, stop: 98, target: 104, highWater: 100, candlesHeld: 0, reason: 'test',
  };
  const quote = { symbol: 'TEST-USD', bid: 100, ask: 100, time: 0 };
  const both = exitTrigger(pos, quote, { time: 0, open: 100, high: 105, low: 97, close: 101, volume: 1 }, cfg.executor);
  assert.equal(both?.refPrice, 98);
  const gap = exitTrigger(pos, quote, { time: 0, open: 95, high: 96, low: 94, close: 95, volume: 1 }, cfg.executor);
  assert.equal(gap?.refPrice, 95);
  assert.equal(exitTrigger(pos, quote, { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 }, cfg.executor), null);

  trail(pos, 103, cfg.executor);
  assert.equal(pos.stop, 103 - cfg.executor.trailAtrMult);
  trail(pos, 101, cfg.executor);
  assert.equal(pos.stop, 103 - cfg.executor.trailAtrMult, 'stop never moves down');
});
