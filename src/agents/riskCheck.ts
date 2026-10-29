// Risk check: nothing executes before a pass.
import type { BotConfig } from '../config.ts';
import { fmtPct, spreadBps } from '../market.ts';
import type { MarketSnapshot, Signal } from '../types.ts';

export interface RiskContext {
  holding: boolean;
  openPositions: number;
  killSwitch: boolean;
  /** Market time the symbol's loss cooldown ends, if any. */
  cooldownUntil: number | undefined;
  /** Fees for both legs, in bps. The spread is added from the live quote. */
  roundTripFeeBps: number;
  /** Distance from entry to target, as a fraction of price. */
  rewardPct: number;
}

export interface RiskResult {
  pass: boolean;
  failures: string[];
  summary: string;
}

export function riskCheck(signal: Signal, snap: MarketSnapshot, ctx: RiskContext, cfg: BotConfig['risk']): RiskResult {
  const failures: string[] = [];
  const spread = spreadBps(snap.quote);
  const atrPct = signal.atr / signal.price;
  const quoteAge = snap.time - snap.quote.time;

  if (ctx.killSwitch) failures.push(`daily loss limit ${fmtPct(cfg.maxDailyDrawdownPct, 0)} hit, no new trades today`);
  if (ctx.holding) failures.push('already holding this symbol');
  if (ctx.openPositions >= cfg.maxOpenPositions) failures.push(`max ${cfg.maxOpenPositions} open positions`);
  if (ctx.cooldownUntil !== undefined && snap.time < ctx.cooldownUntil) {
    failures.push(`cooling down after a loss for ${Math.ceil((ctx.cooldownUntil - snap.time) / 60)} more min`);
  }
  if (!(spread <= cfg.maxSpreadBps)) failures.push(`spread ${spread.toFixed(1)}bps > ${cfg.maxSpreadBps}bps`);
  if (!Number.isFinite(atrPct) || atrPct <= 0) failures.push('no usable ATR');
  else if (atrPct > cfg.maxAtrPct) failures.push(`too volatile: ATR ${fmtPct(atrPct)} of price > ${fmtPct(cfg.maxAtrPct)}`);
  const costPct = (ctx.roundTripFeeBps + spread) / 10_000;
  if (ctx.rewardPct < costPct * cfg.minRewardToCost) {
    failures.push(`target ${fmtPct(ctx.rewardPct)} away doesn't cover ${cfg.minRewardToCost}x the ${fmtPct(costPct)} round-trip cost`);
  }
  if (quoteAge > cfg.maxQuoteAgeSec) failures.push(`quote is ${quoteAge}s stale`);

  return {
    pass: failures.length === 0,
    failures,
    summary: `spread ${spread.toFixed(1)}bps · ATR ${fmtPct(atrPct)} · ${ctx.openPositions}/${cfg.maxOpenPositions} open`,
  };
}
