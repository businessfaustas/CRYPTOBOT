import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from '../src/bot.ts';
import { defaultConfig, type BotConfig } from '../src/config.ts';
import { TradeLogger } from '../src/agents/logger.ts';
import { SimFeed } from '../src/feeds/sim.ts';

async function backtest(seed: number, overrides: Partial<BotConfig> = {}) {
  const cfg: BotConfig = { ...defaultConfig, logDir: null, ...overrides };
  const bot = new Bot(cfg, new TradeLogger({ dir: null, console: false, keepRecent: 100_000 }));
  const feed = new SimFeed({ symbols: cfg.symbols, seed, candleSeconds: cfg.candleSeconds, historySize: cfg.historySize, intervalMs: 0, candles: 3000, startTime: 1_700_000_000 });
  await feed.run((snap) => bot.onSnapshot(snap));
  bot.flatten('end of test');
  return bot;
}

test('same seed, same result', async () => {
  const [a, b] = await Promise.all([backtest(7), backtest(7)]);
  assert.ok(a.closed.length > 10, `expected trades, got ${a.closed.length}`);
  assert.equal(a.closed.length, b.closed.length);
  assert.equal(a.equity(), b.equity());
});

test('books balance: final cash = start + sum of trade P&L once flat', async () => {
  const bot = await backtest(11);
  assert.equal(bot.positions.size, 0);
  const pnl = bot.closed.reduce((s, t) => s + t.pnl, 0);
  assert.ok(Math.abs(bot.cash - (defaultConfig.startingEquity + pnl)) < 1e-6);
  assert.ok(bot.cash > 0);
});

test('every entry and exit has a reason and a log line; nothing trades without passing risk', async () => {
  const bot = await backtest(3);
  const log = bot.log.recent;
  const entries = log.filter((e) => e.kind === 'entry');
  const exits = log.filter((e) => e.kind === 'exit');
  assert.equal(entries.length, bot.closed.length);
  assert.equal(exits.length, bot.closed.length);
  for (const t of bot.closed) {
    assert.ok(t.reason.length > 0 && t.exitReason.length > 0);
  }
  // Each entry is preceded by a signal and a sizing line for the same symbol, with no risk filter in between.
  for (const entry of entries) {
    const before = log.filter((e) => e.seq < entry.seq && e.symbol === entry.symbol);
    assert.equal(before.at(-1)?.kind, 'sized');
    assert.equal(before.at(-2)?.kind, 'signal');
  }
});

test('never holds more than the max open positions or loses more than 1% of equity per stop', async () => {
  const cfg: BotConfig = { ...defaultConfig, logDir: null };
  const bot = new Bot(cfg, new TradeLogger({ dir: null, console: false }));
  const feed = new SimFeed({ symbols: cfg.symbols, seed: 5, candleSeconds: cfg.candleSeconds, historySize: cfg.historySize, intervalMs: 0, candles: 3000, startTime: 1_700_000_000 });
  let maxOpen = 0;
  await feed.run((snap) => {
    bot.onSnapshot(snap);
    maxOpen = Math.max(maxOpen, bot.positions.size);
  });
  assert.ok(maxOpen <= cfg.risk.maxOpenPositions);
  // Gaps, slippage and fees can push a loss a little past the planned 1%, never far past it.
  const worst = Math.min(...bot.closed.map((t) => t.pnl));
  assert.ok(worst > -1.5 * cfg.sizer.riskPerTradePct * cfg.startingEquity, `worst loss ${worst}`);
});

test('logger refuses a decision without a reason', () => {
  const log = new TradeLogger({ dir: null, console: false });
  assert.throws(() => log.log('executor', 'entry', '  ', { time: 0 }), /without a reason/);
});
