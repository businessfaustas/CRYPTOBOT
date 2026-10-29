// Logger: no decision without a reason, and every decision gets a line in the log.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentName, LogEntry, LogKind } from '../types.ts';

export interface LoggerOptions {
  /** Directory for the JSONL log. `null` keeps the log in memory only. */
  dir: string | null;
  console: boolean;
  keepRecent?: number;
}

const COLORS: Partial<Record<LogKind, string>> = {
  entry: '\x1b[32m',
  exit: '\x1b[36m',
  filtered: '\x1b[31m',
  killswitch: '\x1b[41m',
  error: '\x1b[31m',
  signal: '\x1b[33m',
};

export class TradeLogger {
  readonly file: string | null;
  readonly recent: LogEntry[] = [];
  private seq = 0;
  private readonly keepRecent: number;
  private readonly toConsole: boolean;

  constructor(opts: LoggerOptions) {
    this.keepRecent = opts.keepRecent ?? 300;
    this.toConsole = opts.console;
    if (opts.dir) {
      mkdirSync(opts.dir, { recursive: true });
      this.file = join(opts.dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    } else {
      this.file = null;
    }
  }

  get count(): number {
    return this.seq;
  }

  log(agent: AgentName, kind: LogKind, message: string, extra: { time: number; symbol?: string; data?: Record<string, unknown> }): LogEntry {
    if (!message.trim()) throw new Error(`${agent} tried to log a ${kind} without a reason`);
    const entry: LogEntry = { seq: ++this.seq, time: extra.time, agent, kind, message };
    if (extra.symbol) entry.symbol = extra.symbol;
    if (extra.data) entry.data = extra.data;

    this.recent.push(entry);
    if (this.recent.length > this.keepRecent) this.recent.shift();
    if (this.file) appendFileSync(this.file, JSON.stringify(entry) + '\n');
    if (this.toConsole) this.print(entry);
    return entry;
  }

  private print(e: LogEntry): void {
    const t = new Date(e.time * 1000).toISOString().slice(11, 19);
    const color = COLORS[e.kind] ?? '\x1b[2m';
    const tag = `${e.agent}/${e.kind}`.padEnd(18);
    console.log(`${color}${t} #${String(e.seq).padStart(4, '0')} ${tag}\x1b[0m ${e.symbol ? e.symbol.padEnd(9) : ''}${e.message}`);
  }
}
