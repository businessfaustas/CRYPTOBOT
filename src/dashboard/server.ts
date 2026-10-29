import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Bot } from '../bot.ts';
import { mid, spreadBps } from '../market.ts';

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');

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

export function startDashboard(bot: Bot, info: DashboardInfo, port: number): Server {
  const clients = new Set<import('node:http').ServerResponse>();
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    } else if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(dashboardState(bot, info)));
    } else if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(dashboardState(bot, info))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else {
      res.writeHead(404).end('not found');
    }
  });

  const timer = setInterval(() => {
    if (clients.size === 0) return;
    const payload = `data: ${JSON.stringify(dashboardState(bot, info))}\n\n`;
    for (const c of clients) c.write(payload);
  }, 1000);
  server.on('close', () => {
    clearInterval(timer);
    for (const c of clients) c.end();
  });
  server.listen(port, '127.0.0.1');
  return server;
}
