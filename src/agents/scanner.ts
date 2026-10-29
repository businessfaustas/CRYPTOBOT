// Scanner: flags setups, never trades.
import type { BotConfig } from '../config.ts';
import { atr, ema, fmtPrice, mean } from '../market.ts';
import type { MarketSnapshot, Signal } from '../types.ts';

export interface ScanResult {
  signal: Signal | null;
  /** One-line summary for the dashboard, set whether or not a signal fired. */
  note: string;
}

export function scan(snap: MarketSnapshot, cfg: BotConfig['scanner']): ScanResult {
  const candles = snap.candles;
  const need = Math.max(cfg.slowEma * 3, cfg.breakoutLookback + 1, cfg.atrPeriod + 1);
  if (candles.length < need) return { signal: null, note: `warming up ${candles.length}/${need}` };

  const last = candles[candles.length - 1]!;
  const prior = candles.slice(-1 - cfg.breakoutLookback, -1);
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, cfg.fastEma).at(-1)!;
  const slow = ema(closes, cfg.slowEma).at(-1)!;
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const avgVolume = mean(prior.map((c) => c.volume));
  const volumeRatio = avgVolume > 0 ? last.volume / avgVolume : 0;
  const a = atr(candles, cfg.atrPeriod);

  const trendUp = fast > slow;
  const breakout = last.close > priorHigh;
  const volumeOk = volumeRatio >= cfg.volumeSpikeMult;

  if (!(trendUp && breakout && volumeOk)) {
    const missing = [
      trendUp ? null : `EMA${cfg.fastEma} below EMA${cfg.slowEma}`,
      breakout ? null : `${pctBelow(last.close, priorHigh)} under ${cfg.breakoutLookback}-bar high`,
      volumeOk ? null : `volume ${volumeRatio.toFixed(1)}x`,
    ].filter(Boolean);
    return { signal: null, note: `no setup: ${missing.join(', ')}` };
  }

  const clearance = (last.close - priorHigh) / a;
  const strength = clamp01(0.4 * Math.min(clearance, 1) + 0.3 * Math.min(volumeRatio / (cfg.volumeSpikeMult * 2), 1) + 0.3 * Math.min(((fast - slow) / a) * 2, 1));
  const reason =
    `close ${fmtPrice(last.close)} broke ${cfg.breakoutLookback}-bar high ${fmtPrice(priorHigh)}` +
    ` · EMA${cfg.fastEma} > EMA${cfg.slowEma}` +
    ` · volume ${volumeRatio.toFixed(1)}x avg`;

  return {
    signal: { symbol: snap.symbol, time: snap.time, price: last.close, atr: a, strength, reason },
    note: `SIGNAL ${reason}`,
  };
}

function pctBelow(price: number, level: number): string {
  return `${(((level - price) / level) * 100).toFixed(2)}%`;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
