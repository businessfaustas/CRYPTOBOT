export interface BotConfig {
  symbols: string[];
  startingEquity: number;
  /** Candle size in seconds. Coinbase accepts 60, 300, 900, 3600, 21600, 86400. */
  candleSeconds: number;
  /** Closed candles kept per symbol. */
  historySize: number;
  scanner: {
    fastEma: number;
    slowEma: number;
    /** A signal needs the close to clear the highest high of this many prior bars. */
    breakoutLookback: number;
    /** ...on at least this multiple of the average volume of those bars. */
    volumeSpikeMult: number;
    atrPeriod: number;
  };
  risk: {
    maxSpreadBps: number;
    /** Skip markets whose ATR is above this fraction of price. */
    maxAtrPct: number;
    maxOpenPositions: number;
    /** Stop opening trades for the rest of the UTC day after losing this fraction of equity. */
    maxDailyDrawdownPct: number;
    /** Candles to sit out a symbol after a losing trade on it. */
    lossCooldownCandles: number;
    maxQuoteAgeSec: number;
    /** The move to the target must cover the round-trip cost (fees both ways + spread) this many times. */
    minRewardToCost: number;
  };
  sizer: {
    /** Fraction of equity lost if the stop is hit. */
    riskPerTradePct: number;
    /** Largest position as a fraction of equity. */
    maxPositionPct: number;
    minNotional: number;
    stopAtrMult: number;
    targetAtrMult: number;
  };
  executor: {
    feeBps: number;
    /** Entries that would slip more than this versus mid are cancelled. */
    maxSlippageBps: number;
    /** Market impact in bps per 1% of the bar's dollar volume taken. */
    impactBpsPerPctVolume: number;
    trailAtrMult: number;
    maxHoldCandles: number;
  };
  logDir: string | null;
}

export const defaultConfig: BotConfig = {
  symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD', 'AVAX-USD', 'LINK-USD'],
  startingEquity: 1000,
  candleSeconds: 300,
  historySize: 200,
  scanner: {
    fastEma: 9,
    slowEma: 21,
    breakoutLookback: 20,
    volumeSpikeMult: 1.5,
    atrPeriod: 14,
  },
  risk: {
    maxSpreadBps: 20,
    maxAtrPct: 0.02,
    maxOpenPositions: 3,
    maxDailyDrawdownPct: 0.05,
    lossCooldownCandles: 15,
    maxQuoteAgeSec: 120,
    minRewardToCost: 3,
  },
  sizer: {
    riskPerTradePct: 0.01,
    maxPositionPct: 0.25,
    minNotional: 5,
    stopAtrMult: 2,
    targetAtrMult: 4,
  },
  executor: {
    feeBps: 25,
    maxSlippageBps: 30,
    impactBpsPerPctVolume: 5,
    trailAtrMult: 2.5,
    maxHoldCandles: 120,
  },
  logDir: 'logs',
};
