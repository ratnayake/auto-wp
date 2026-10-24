import type { RunRecord } from '../domain.js';
import type {
  ApprovalGate,
  ApprovalRequest,
  ApprovalResult,
  AuditEntry,
  AuditLog,
  Clock,
  Logger,
  RunStore,
  SecretStore,
} from '../services.js';

export * from './fake-connection.js';

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string = '2026-01-01T00:00:00Z') {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(d: Date | string): void {
    this.t = new Date(d).getTime();
  }
}

export class InMemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  async append(e: AuditEntry): Promise<void> {
    this.entries.push(structuredClone(e));
  }
  async tail(limit: number): Promise<AuditEntry[]> {
    return this.entries.slice(-limit);
  }
}

export class InMemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.values.set(k, v);
  }
  async get(ref: string): Promise<string> {
    const v = this.values.get(ref);
    if (v === undefined) throw new Error(`secret not found: ${ref}`);
    return v;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}

export class InMemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();
  async save(r: RunRecord): Promise<void> {
    this.runs.set(r.runId, structuredClone(r));
  }
  async get(runId: string): Promise<RunRecord | undefined> {
    const r = this.runs.get(runId);
    return r && structuredClone(r);
  }
  async list(siteId?: string): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => !siteId || r.siteId === siteId)
      .map((r) => structuredClone(r));
  }
}

/** Approves (or denies) everything, recording requests. */
export class StaticApprovalGate implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];
  constructor(
    private readonly approve: boolean,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}
  async request(r: ApprovalRequest): Promise<ApprovalResult> {
    this.requests.push(r);
    return { approved: this.approve, by: 'test', planHash: r.planHash, at: this.clock.now().toISOString() };
  }
}

export class MemoryLogger implements Logger {
  readonly lines: Array<{ level: string; obj: object | string; msg?: string }> = [];
  debug(obj: object | string, msg?: string) {
    this.lines.push({ level: 'debug', obj, msg });
  }
  info(obj: object | string, msg?: string) {
    this.lines.push({ level: 'info', obj, msg });
  }
  warn(obj: object | string, msg?: string) {
    this.lines.push({ level: 'warn', obj, msg });
  }
  error(obj: object | string, msg?: string) {
    this.lines.push({ level: 'error', obj, msg });
  }
}
