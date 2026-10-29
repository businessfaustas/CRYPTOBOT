// Sizer: sizes from account equity and the stop distance, never a fixed ticket.
import type { BotConfig } from '../config.ts';
import { fmtPct, fmtPrice, fmtQty, fmtUsd } from '../market.ts';
import type { Signal } from '../types.ts';

export type SizeResult =
  | { ok: true; qty: number; notional: number; stop: number; target: number; riskDollars: number; reason: string }
  | { ok: false; reason: string };

/**
 * Risk a fixed fraction of equity between entry and stop, then cap the position at
 * `maxPositionPct` of equity and at the cash on hand (leaving room for fees and slippage).
 */
export function size(signal: Signal, equity: number, cash: number, cfg: BotConfig['sizer'], exec: BotConfig['executor']): SizeResult {
  const stop = signal.price - cfg.stopAtrMult * signal.atr;
  const target = signal.price + cfg.targetAtrMult * signal.atr;
  const riskPerUnit = signal.price - stop;
  if (!(riskPerUnit > 0) || stop <= 0) return { ok: false, reason: `stop ${fmtPrice(stop)} is not below entry` };

  const riskDollars = equity * cfg.riskPerTradePct;
  const byRisk = riskDollars / riskPerUnit;
  const byCap = (equity * cfg.maxPositionPct) / signal.price;
  const costBuffer = 1 + (exec.feeBps + exec.maxSlippageBps) / 10_000;
  const byCash = cash / costBuffer / signal.price;
  const qty = Math.min(byRisk, byCap, byCash);
  const notional = qty * signal.price;

  const limit = qty === byRisk ? `risk ${fmtPct(cfg.riskPerTradePct, 1)}` : qty === byCap ? `${fmtPct(cfg.maxPositionPct, 0)} cap` : 'cash on hand';
  if (notional < cfg.minNotional) {
    return { ok: false, reason: `size ${fmtUsd(notional)} under ${fmtUsd(cfg.minNotional)} minimum (limited by ${limit})` };
  }

  return {
    ok: true,
    qty,
    notional,
    stop,
    target,
    riskDollars: qty * riskPerUnit,
    reason:
      `${fmtQty(qty)} units = ${fmtUsd(notional)} (${fmtPct(notional / equity, 1)} of ${fmtUsd(equity)} equity, limited by ${limit})` +
      ` · stop ${fmtPrice(stop)} risks ${fmtUsd(qty * riskPerUnit)} · target ${fmtPrice(target)}`,
  };
}
