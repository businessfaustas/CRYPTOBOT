// Executor: paper fills with spread, market impact and fees; tracks slippage; decides exits.
import type { BotConfig } from '../config.ts';
import { fmtPrice } from '../market.ts';
import type { Candle, Position, Quote } from '../types.ts';

export interface Fill {
  price: number;
  qty: number;
  notional: number;
  fee: number;
  /** How far the fill landed from the reference price, against us. */
  slippageBps: number;
}

export type FillResult = { ok: true; fill: Fill } | { ok: false; reason: string };

/**
 * Simulate a market order against `refPrice` (mid for entries, the trigger price for exits).
 * Cost = half the spread + impact proportional to the share of the bar's dollar volume taken.
 * Entries over the slippage cap are cancelled; exits always fill because a stop has to get out.
 */
export function simulateFill(
  side: 'buy' | 'sell',
  qty: number,
  refPrice: number,
  spreadBps: number,
  barVolume: number,
  cfg: BotConfig['executor'],
  enforceCap = side === 'buy',
): FillResult {
  const dollarVolume = barVolume * refPrice;
  const participationPct = dollarVolume > 0 ? ((qty * refPrice) / dollarVolume) * 100 : 100;
  const slippageBps = spreadBps / 2 + participationPct * cfg.impactBpsPerPctVolume;
  if (enforceCap && slippageBps > cfg.maxSlippageBps) {
    return { ok: false, reason: `expected slippage ${slippageBps.toFixed(1)}bps > ${cfg.maxSlippageBps}bps cap, order cancelled` };
  }
  const price = refPrice * (side === 'buy' ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000);
  const notional = qty * price;
  return { ok: true, fill: { price, qty, notional, fee: (notional * cfg.feeBps) / 10_000, slippageBps } };
}

export interface ExitTrigger {
  refPrice: number;
  reason: string;
}

/**
 * Decide whether a position should close. With a closed `bar` (sim and replay) the stop and
 * target trigger intrabar, stop first when both were touched; otherwise the live bid decides.
 */
export function exitTrigger(pos: Position, quote: Quote, bar: Candle | undefined, cfg: BotConfig['executor']): ExitTrigger | null {
  const stopKind = pos.stop > pos.entryPrice ? 'trailing stop' : 'stop';
  if (bar) {
    if (bar.open <= pos.stop) return { refPrice: bar.open, reason: `gapped through ${stopKind} ${fmtPrice(pos.stop)}, out at open` };
    if (bar.low <= pos.stop) return { refPrice: pos.stop, reason: `${stopKind} ${fmtPrice(pos.stop)} hit` };
    if (bar.high >= pos.target) return { refPrice: Math.max(pos.target, bar.open), reason: `target ${fmtPrice(pos.target)} hit` };
  } else {
    if (quote.bid <= pos.stop) return { refPrice: quote.bid, reason: `${stopKind} ${fmtPrice(pos.stop)} hit (bid ${fmtPrice(quote.bid)})` };
    if (quote.bid >= pos.target) return { refPrice: quote.bid, reason: `target ${fmtPrice(pos.target)} hit (bid ${fmtPrice(quote.bid)})` };
  }
  if (pos.candlesHeld >= cfg.maxHoldCandles) return { refPrice: quote.bid, reason: `time stop after ${pos.candlesHeld} candles` };
  return null;
}

/** Ratchet the stop up behind the high-water mark. Never moves it down. */
export function trail(pos: Position, high: number, cfg: BotConfig['executor']): void {
  pos.highWater = Math.max(pos.highWater, high);
  const trailed = pos.highWater - cfg.trailAtrMult * pos.atr;
  if (trailed > pos.stop) pos.stop = trailed;
}
