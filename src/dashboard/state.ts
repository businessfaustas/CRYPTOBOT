// Pure snapshot of the bot for the dashboard, shared by the Node server and the browser preview.
import type { Bot } from '../bot.ts';
import { mid, spreadBps } from '../market.ts';

export interface DashboardInfo {
  mode: string;
  feed: string;
}

export function dashboardState(bot: Bot, info: DashboardInfo) {
  const stats = bot.equityCurve.stats(bot.closed);
  return {
    ...info,
    paper: true,
    now: bot.now,
    equity: bot.equity(),
    cash: bot.cash,
    killSwitch: bot.killSwitch,
    stats: { ...stats, profitFactor: Number.isFinite(stats.profitFactor) ? stats.profitFactor : null },
    agents: bot.agents,
    markets: bot.cfg.symbols.map((symbol) => {
      const q = bot.quotes.get(symbol);
      return { symbol, price: q ? mid(q) : null, spreadBps: q ? spreadBps(q) : null, note: bot.scanNotes.get(symbol) ?? 'waiting for data' };
    }),
    positions: [...bot.positions.values()].map((p) => {
      const bid = bot.quotes.get(p.symbol)?.bid ?? p.entryPrice;
      return { ...p, mark: bid, unrealized: (bid - p.entryPrice) * p.qty - p.entryFee, unrealizedPct: bid / p.entryPrice - 1 };
    }),
    trades: bot.closed.slice(-40).reverse(),
    log: bot.log.recent.slice(-120).reverse(),
    curve: bot.equityCurve.sample(400),
  };
}
