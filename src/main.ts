import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Bot } from './bot.ts';
import { defaultConfig, type BotConfig } from './config.ts';
import { TradeLogger } from './agents/logger.ts';
import { startDashboard } from './dashboard/server.ts';
import { CoinbaseLiveFeed, fetchHistory } from './feeds/coinbase.ts';
import { ReplayFeed } from './feeds/replay.ts';
import { SimFeed } from './feeds/sim.ts';
import { fmtPct, fmtUsd } from './market.ts';
import type { Feed } from './types.ts';

const HELP = `cryptobot: six-agent crypto PAPER trader (no real orders, ever)

  --mode live|sim|backtest   live = Coinbase prices, sim = synthetic market in real time,
                             backtest = run to completion and print a report (default sim)
  --source sim|coinbase      backtest data source (default sim)
  --symbols BTC-USD,ETH-USD  products to watch (default ${defaultConfig.symbols.join(',')})
  --equity 1000              starting paper balance in USD
  --granularity 300          candle seconds: 60, 300, 900, 3600, 21600, 86400
  --candles 5000             backtest length in candles per symbol
  --seed 42                  sim seed
  --speed 250                sim mode: real milliseconds per candle
  --poll 15                  live mode: seconds between ticker polls
  --port 8787                dashboard port
  --no-dashboard             don't start the dashboard
  --quiet                    don't print every log line
`;

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'sim' },
    source: { type: 'string', default: 'sim' },
    symbols: { type: 'string' },
    equity: { type: 'string' },
    granularity: { type: 'string', default: String(defaultConfig.candleSeconds) },
    candles: { type: 'string', default: '5000' },
    seed: { type: 'string', default: '42' },
    speed: { type: 'string', default: '250' },
    poll: { type: 'string', default: '15' },
    port: { type: 'string', default: '8787' },
    'no-dashboard': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const mode = values.mode;
if (mode !== 'live' && mode !== 'sim' && mode !== 'backtest') {
  console.error(`unknown --mode ${mode}\n\n${HELP}`);
  process.exit(1);
}

const cfg: BotConfig = {
  ...defaultConfig,
  symbols: values.symbols ? values.symbols.split(',').map((s) => s.trim().toUpperCase()) : defaultConfig.symbols,
  startingEquity: values.equity ? Number(values.equity) : defaultConfig.startingEquity,
  candleSeconds: Number(values.granularity),
};
const backtest = mode === 'backtest';
const log = new TradeLogger({ dir: cfg.logDir, console: !values.quiet && !backtest });
const bot = new Bot(cfg, log);

let feed: Feed;
if (mode === 'live') {
  feed = new CoinbaseLiveFeed({
    symbols: cfg.symbols,
    granularity: cfg.candleSeconds,
    historySize: cfg.historySize,
    pollSeconds: Number(values.poll),
    onError: (err, symbol) => log.log('logger', 'error', `feed error, retrying next poll: ${err.message}`, { time: Math.floor(Date.now() / 1000), symbol }),
  });
} else if (backtest && values.source === 'coinbase') {
  const count = Number(values.candles);
  console.log(`fetching ${count} × ${cfg.candleSeconds}s candles per symbol from Coinbase…`);
  const candles: Record<string, Awaited<ReturnType<typeof fetchHistory>>> = {};
  for (const symbol of cfg.symbols) {
    try {
      candles[symbol] = await fetchHistory(symbol, cfg.candleSeconds, count);
    } catch (err) {
      console.error(`could not download ${symbol}: ${(err as Error).message}`);
      process.exit(1);
    }
    console.log(`  ${symbol}: ${candles[symbol].length} candles`);
  }
  feed = new ReplayFeed({ candles, candleSeconds: cfg.candleSeconds, historySize: cfg.historySize, spreadBps: 5 });
} else {
  feed = new SimFeed({
    symbols: cfg.symbols,
    seed: Number(values.seed),
    candleSeconds: cfg.candleSeconds,
    historySize: cfg.historySize,
    intervalMs: backtest ? 0 : Number(values.speed),
    candles: backtest ? Number(values.candles) : undefined,
  });
}

const port = Number(values.port);
const dashboard = values['no-dashboard'] || backtest ? null : startDashboard(bot, { mode, feed: feed.name }, port);
log.log('logger', 'system', `PAPER ${mode} on ${feed.name} · ${cfg.symbols.join(', ')} · ${fmtUsd(cfg.startingEquity)} starting equity`, {
  time: Math.floor(Date.now() / 1000),
});
if (dashboard) console.log(`dashboard → http://localhost:${port}`);

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(1);
  stopping = true;
  feed.stop();
});

try {
  await feed.run((snap) => bot.onSnapshot(snap));
} catch (err) {
  dashboard?.close();
  const cause = (err as Error & { cause?: Error }).cause;
  console.error(`\nfeed ${feed.name} failed: ${(err as Error).message}${cause ? ` (${cause.message})` : ''}`);
  if (mode === 'live') console.error('Check your internet connection, or run `npm run sim` to try the bot offline.');
  process.exit(1);
}
dashboard?.close();
if (backtest) bot.flatten('end of backtest');
report();

function report(): void {
  const s = bot.equityCurve.stats(bot.closed);
  const lines = [
    '',
    `── ${mode} result (${feed.name}) ──`,
    `start           ${fmtUsd(s.start)}`,
    `end             ${fmtUsd(bot.equity())}  (${fmtPct(s.returnPct)})`,
    `trades          ${s.trades}  (${s.wins} wins / ${s.losses} losses, ${fmtPct(s.winRate, 0)} win rate)`,
    `avg win / loss  ${fmtUsd(s.avgWin)} / ${fmtUsd(s.avgLoss)}`,
    `profit factor   ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}`,
    `max drawdown    ${fmtPct(s.maxDrawdownPct)}`,
    `fees paid       ${fmtUsd(s.fees)}`,
    `avg slippage    ${s.avgSlippageBps.toFixed(1)}bps per fill`,
    `log             ${log.file ?? '(memory only)'} · ${log.count} lines`,
  ];
  if (bot.positions.size) lines.push(`still open      ${[...bot.positions.keys()].join(', ')}`);
  console.log(lines.join('\n'));
  if (log.file) {
    const csv = 'time,equity\n' + bot.equityCurve.points.map((p) => `${p.time},${p.equity.toFixed(2)}`).join('\n');
    writeFileSync(join(cfg.logDir!, 'equity-latest.csv'), csv);
  }
}
