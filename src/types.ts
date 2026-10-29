export interface Candle {
  /** Bar open time, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume in base units (BTC for BTC-USD). */
  volume: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  /** Unix seconds. */
  time: number;
}

export interface MarketSnapshot {
  symbol: string;
  /** Unix seconds. */
  time: number;
  /** Closed candles, oldest first. */
  candles: Candle[];
  quote: Quote;
  /** True when a new candle closed since the previous snapshot for this symbol. */
  newCandle: boolean;
  /** The bar that just closed. Sim and replay feeds set it so stops can trigger intrabar. */
  bar?: Candle;
}

export interface Feed {
  readonly name: string;
  /** Resolves when the feed runs out of data or `stop()` is called. */
  run(onSnapshot: (snap: MarketSnapshot) => void): Promise<void>;
  stop(): void;
}

export interface Signal {
  symbol: string;
  time: number;
  price: number;
  atr: number;
  /** 0..1, how strongly the setup fired. */
  strength: number;
  reason: string;
}

export interface Position {
  id: number;
  symbol: string;
  qty: number;
  entryPrice: number;
  entryTime: number;
  entryFee: number;
  entrySlippageBps: number;
  /** ATR at entry; the trailing stop is measured in it. */
  atr: number;
  stop: number;
  target: number;
  highWater: number;
  candlesHeld: number;
  reason: string;
}

export interface ClosedTrade extends Position {
  exitPrice: number;
  exitTime: number;
  exitFee: number;
  exitSlippageBps: number;
  exitReason: string;
  pnl: number;
  pnlPct: number;
}

export type AgentName = 'scanner' | 'risk' | 'sizer' | 'executor' | 'logger' | 'equity';

export type LogKind =
  | 'signal'
  | 'filtered'
  | 'sized'
  | 'skip'
  | 'entry'
  | 'exit'
  | 'killswitch'
  | 'system'
  | 'error';

export interface LogEntry {
  seq: number;
  /** Market time (unix seconds) the decision was made at. */
  time: number;
  agent: AgentName;
  kind: LogKind;
  symbol?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface AgentStatus {
  state: 'idle' | 'working' | 'blocked';
  last: string;
  count: number;
}
