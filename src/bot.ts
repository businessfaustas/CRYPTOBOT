import type { BotConfig } from './config.ts';
import { EquityTracker } from './agents/equity.ts';
import { exitTrigger, simulateFill, trail } from './agents/executor.ts';
import type { TradeLogger } from './agents/logger.ts';
import { riskCheck } from './agents/riskCheck.ts';
import { scan } from './agents/scanner.ts';
import { size } from './agents/sizer.ts';
import { fmtPct, fmtPrice, fmtQty, fmtUsd, mid, spreadBps } from './market.ts';
import type { AgentName, AgentStatus, ClosedTrade, MarketSnapshot, Position, Quote } from './types.ts';

/**
 * Runs the pipeline on every snapshot: executor manages exits, then on each closed candle
 * scanner → risk check → sizer → executor, with the logger recording every decision and the
 * equity tracker marking the account to market. Paper only: fills are simulated in memory.
 */
export class Bot {
  readonly cfg: BotConfig;
  readonly log: TradeLogger;
  readonly equityCurve: EquityTracker;
  readonly positions = new Map<string, Position>();
  readonly closed: ClosedTrade[] = [];
  readonly quotes = new Map<string, Quote>();
  readonly scanNotes = new Map<string, string>();
  readonly agents: Record<AgentName, AgentStatus>;
  cash: number;
  killSwitch = false;
  now = 0;

  private readonly cooldownUntil = new Map<string, number>();
  private dayKey = '';
  private dayStartEquity: number;
  private nextId = 1;

  constructor(cfg: BotConfig, log: TradeLogger) {
    this.cfg = cfg;
    this.log = log;
    this.cash = cfg.startingEquity;
    this.dayStartEquity = cfg.startingEquity;
    this.equityCurve = new EquityTracker(cfg.startingEquity);
    const idle = (last: string): AgentStatus => ({ state: 'idle', last, count: 0 });
    this.agents = {
      scanner: idle('waiting for candles'),
      risk: idle('nothing to check'),
      sizer: idle('nothing to size'),
      executor: idle('no orders'),
      logger: idle('line #0'),
      equity: idle(fmtUsd(cfg.startingEquity)),
    };
  }

  equity(): number {
    let value = this.cash;
    for (const p of this.positions.values()) value += p.qty * (this.quotes.get(p.symbol)?.bid ?? p.entryPrice);
    return value;
  }

  onSnapshot(snap: MarketSnapshot): void {
    this.now = Math.max(this.now, snap.time);
    this.quotes.set(snap.symbol, snap.quote);
    this.rollDay(snap.time);

    this.manageExit(snap);
    if (snap.newCandle) this.lookForEntry(snap);

    const equity = this.equity();
    this.checkKillSwitch(equity, snap.time);
    this.equityCurve.record(snap.time, equity);
    this.setAgent('equity', 'idle', `${fmtUsd(equity)} · ${this.closed.length} closes`, false);
    this.setAgent('logger', 'idle', `line #${this.log.count}${this.log.file ? ` → ${this.log.file}` : ''}`, false);
    this.agents.equity.count = this.equityCurve.points.length;
    this.agents.logger.count = this.log.count;
  }

  /** Close every open position at the current bid, e.g. at the end of a backtest. */
  flatten(reason: string): void {
    for (const pos of [...this.positions.values()]) {
      const quote = this.quotes.get(pos.symbol);
      if (quote) this.close(pos, quote.bid, reason, quote, Infinity);
    }
  }

  private lookForEntry(snap: MarketSnapshot): void {
    const { symbol, time, quote } = snap;
    const result = scan(snap, this.cfg.scanner);
    this.scanNotes.set(symbol, result.note);
    const signal = result.signal;
    if (!signal) {
      this.setAgent('scanner', 'idle', `${symbol} ${result.note}`, false);
      return;
    }
    this.setAgent('scanner', 'working', `flagged ${symbol}`);
    this.log.log('scanner', 'signal', signal.reason, { time, symbol, data: { price: signal.price, atr: signal.atr, strength: signal.strength } });

    const risk = riskCheck(
      signal,
      snap,
      {
        holding: this.positions.has(symbol),
        openPositions: this.positions.size,
        killSwitch: this.killSwitch,
        cooldownUntil: this.cooldownUntil.get(symbol),
        roundTripFeeBps: 2 * this.cfg.executor.feeBps,
        rewardPct: (this.cfg.sizer.targetAtrMult * signal.atr) / signal.price,
      },
      this.cfg.risk,
    );
    if (!risk.pass) {
      this.setAgent('risk', 'blocked', `filtered ${symbol}: ${risk.failures[0]}`);
      this.log.log('risk', 'filtered', `not traded: ${risk.failures.join('; ')}`, { time, symbol, data: { failures: risk.failures } });
      return;
    }
    this.setAgent('risk', 'idle', `passed ${symbol}: ${risk.summary}`);

    const equity = this.equity();
    const sized = size(signal, equity, this.cash, this.cfg.sizer, this.cfg.executor);
    if (!sized.ok) {
      this.setAgent('sizer', 'blocked', `${symbol}: ${sized.reason}`);
      this.log.log('sizer', 'skip', `no order: ${sized.reason}`, { time, symbol });
      return;
    }
    this.setAgent('sizer', 'idle', `${symbol} ${fmtPct(sized.notional / equity, 1)} of equity`);
    this.log.log('sizer', 'sized', sized.reason, { time, symbol, data: { qty: sized.qty, notional: sized.notional, stop: sized.stop, target: sized.target } });

    const bar = snap.candles.at(-1)!;
    const filled = simulateFill('buy', sized.qty, mid(quote), spreadBps(quote), bar.volume, this.cfg.executor);
    if (!filled.ok) {
      this.setAgent('executor', 'blocked', `${symbol}: ${filled.reason}`);
      this.log.log('executor', 'skip', `no order: ${filled.reason}`, { time, symbol });
      return;
    }
    const fill = filled.fill;
    this.cash -= fill.notional + fill.fee;
    const pos: Position = {
      id: this.nextId++,
      symbol,
      qty: fill.qty,
      entryPrice: fill.price,
      entryTime: time,
      entryFee: fill.fee,
      entrySlippageBps: fill.slippageBps,
      atr: signal.atr,
      stop: sized.stop,
      target: sized.target,
      highWater: fill.price,
      candlesHeld: 0,
      reason: signal.reason,
    };
    this.positions.set(symbol, pos);
    this.setAgent('executor', 'working', `LONG ${symbol} slip ${fill.slippageBps.toFixed(1)}bps`);
    this.log.log(
      'executor',
      'entry',
      `BUY ${fmtQty(fill.qty)} @ ${fmtPrice(fill.price)} (${fmtUsd(fill.notional)}, fee ${fmtUsd(fill.fee)}, slip ${fill.slippageBps.toFixed(1)}bps) · reason: ${signal.reason}`,
      { time, symbol, data: { id: pos.id, qty: fill.qty, price: fill.price, fee: fill.fee, slippageBps: fill.slippageBps, stop: pos.stop, target: pos.target } },
    );
  }

  private manageExit(snap: MarketSnapshot): void {
    const pos = this.positions.get(snap.symbol);
    if (!pos) return;
    if (snap.newCandle && snap.time > pos.entryTime) pos.candlesHeld++;
    // The bar an entry filled on closed at the entry, so it can't trigger that position's stop.
    const bar = snap.bar && snap.bar.time >= pos.entryTime ? snap.bar : undefined;
    const trigger = exitTrigger(pos, snap.quote, bar, this.cfg.executor);
    if (trigger) {
      this.close(pos, trigger.refPrice, trigger.reason, snap.quote, snap.bar?.volume ?? snap.candles.at(-1)?.volume ?? 0);
    } else {
      trail(pos, bar?.high ?? snap.quote.bid, this.cfg.executor);
    }
  }

  private close(pos: Position, refPrice: number, reason: string, quote: Quote, barVolume: number): void {
    const filled = simulateFill('sell', pos.qty, refPrice, spreadBps(quote), barVolume, this.cfg.executor, false);
    if (!filled.ok) throw new Error('exits always fill');
    const fill = filled.fill;
    this.cash += fill.notional - fill.fee;
    const pnl = fill.notional - pos.qty * pos.entryPrice - pos.entryFee - fill.fee;
    const trade: ClosedTrade = {
      ...pos,
      exitPrice: fill.price,
      exitTime: this.now,
      exitFee: fill.fee,
      exitSlippageBps: fill.slippageBps,
      exitReason: reason,
      pnl,
      pnlPct: pnl / (pos.qty * pos.entryPrice),
    };
    this.closed.push(trade);
    this.positions.delete(pos.symbol);
    if (pnl < 0) this.cooldownUntil.set(pos.symbol, this.now + this.cfg.risk.lossCooldownCandles * this.cfg.candleSeconds);

    this.setAgent('executor', 'working', `closed ${pos.symbol} ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}`);
    this.log.log(
      'executor',
      'exit',
      `SELL ${fmtQty(fill.qty)} @ ${fmtPrice(fill.price)} · ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)} (${fmtPct(trade.pnlPct)}) after ${pos.candlesHeld} candles, slip ${fill.slippageBps.toFixed(1)}bps · reason: ${reason}`,
      { time: this.now, symbol: pos.symbol, data: { id: pos.id, price: fill.price, pnl, pnlPct: trade.pnlPct, fee: fill.fee, slippageBps: fill.slippageBps } },
    );
  }

  private rollDay(time: number): void {
    const key = new Date(time * 1000).toISOString().slice(0, 10);
    if (key === this.dayKey) return;
    if (this.dayKey && this.killSwitch) {
      this.log.log('risk', 'system', `new UTC day ${key}, daily loss limit reset`, { time });
      this.setAgent('risk', 'idle', 'daily loss limit reset');
    }
    this.dayKey = key;
    this.dayStartEquity = this.equity();
    this.killSwitch = false;
  }

  private checkKillSwitch(equity: number, time: number): void {
    if (this.killSwitch) return;
    const limit = this.dayStartEquity * (1 - this.cfg.risk.maxDailyDrawdownPct);
    if (equity >= limit) return;
    this.killSwitch = true;
    this.setAgent('risk', 'blocked', 'daily loss limit hit, entries paused');
    this.log.log(
      'risk',
      'killswitch',
      `equity ${fmtUsd(equity)} is down ${fmtPct(1 - equity / this.dayStartEquity)} today, past the ${fmtPct(this.cfg.risk.maxDailyDrawdownPct, 0)} limit; no new entries until the next UTC day (open stops still managed)`,
      { time },
    );
  }

  private setAgent(name: AgentName, state: AgentStatus['state'], last: string, counts = true): void {
    const a = this.agents[name];
    a.state = state;
    a.last = last;
    if (counts) a.count++;
  }
}
