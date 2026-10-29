import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Bot } from '../bot.ts';
import { dashboardState, type DashboardInfo } from './state.ts';

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');

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
