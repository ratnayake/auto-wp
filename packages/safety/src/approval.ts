import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ApprovalGate, ApprovalRequest, ApprovalResult, Clock, Logger } from '@auto-wp/contracts';
import { canonicalJson, sha256Hex } from './canonical.js';

export const planHash = (obj: unknown): string => sha256Hex(canonicalJson(obj));

const codeOf = (hash: string): string => hash.slice(0, 8).toLowerCase();
const systemClock: Clock = { now: () => new Date() };

const result = (r: ApprovalRequest, approved: boolean, by: string, clock: Clock): ApprovalResult => ({
  approved,
  by,
  planHash: r.planHash,
  at: clock.now().toISOString(),
});

export interface ElicitResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}
export type ElicitFn = (message: string, schema: object) => Promise<ElicitResult>;

export class ElicitationApprovalGate implements ApprovalGate {
  constructor(
    private readonly elicit: ElicitFn,
    private readonly clock: Clock = systemClock,
  ) {}

  async request(r: ApprovalRequest): Promise<ApprovalResult> {
    const code = codeOf(r.planHash);
    const message = `Approval required: ${r.action} on site "${r.siteId}"\n${r.summary}\nPlan hash: ${r.planHash}\nType the first 8 characters of the plan hash (${code}) to approve.`;
    const schema = {
      type: 'object',
      properties: {
        confirmation: { type: 'string', title: 'First 8 characters of the plan hash' },
      },
      required: ['confirmation'],
    };
    const res = await this.elicit(message, schema);
    const typed = res.content?.confirmation;
    const ok = res.action === 'accept' && typeof typed === 'string' && typed.trim().toLowerCase() === code;
    return result(r, ok, 'elicitation', this.clock);
  }
}

export interface TtyStreams {
  input: Readable;
  output: Writable;
}

export class TtyApprovalGate implements ApprovalGate {
  constructor(
    private readonly streams: () => TtyStreams = () => ({
      input: createReadStream('/dev/tty'),
      output: createWriteStream('/dev/tty'),
    }),
    private readonly clock: Clock = systemClock,
  ) {}

  async request(r: ApprovalRequest): Promise<ApprovalResult> {
    const { input, output } = this.streams();
    const rl = createInterface({ input, output, terminal: false });
    const code = codeOf(r.planHash);
    try {
      output.write(
        `\nApproval required: ${r.action} on site "${r.siteId}"\n${r.summary}\nPlan hash: ${r.planHash}\n`,
      );
      const answer = await new Promise<string>((resolve) => {
        let done = false;
        rl.once('close', () => !done && resolve(''));
        rl.question(`Type ${code} to approve, anything else to decline: `, (a) => {
          done = true;
          resolve(a);
        });
      });
      return result(r, answer.trim().toLowerCase() === code, 'tty', this.clock);
    } finally {
      rl.close();
    }
  }
}

/** E2E only: approves when AUTOWP_TEST_APPROVE=1. */
export class EnvApprovalGate implements ApprovalGate {
  constructor(
    private readonly logger: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clock: Clock = systemClock,
  ) {}

  async request(r: ApprovalRequest): Promise<ApprovalResult> {
    const ok = this.env.AUTOWP_TEST_APPROVE === '1';
    this.logger.warn(
      { action: r.action, siteId: r.siteId, approved: ok },
      'EnvApprovalGate is active (AUTOWP_TEST_APPROVE): human approval is bypassed. NEVER use in production.',
    );
    return result(r, ok, 'env', this.clock);
  }
}

export class ApprovalError extends Error {}

export class ApprovalLedger {
  private readonly entries = new Map<string, { result: ApprovalResult; expiresAt: number }>();
  private readonly consumed = new Set<string>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly ttlMs = 15 * 60_000,
  ) {}

  /**
   * Records an approved result; denied results are ignored. The TTL runs from the approval time `r.at`
   * (never later than now), an already-recorded approval is not refreshed, and a consumed plan cannot be re-recorded.
   */
  record(r: ApprovalResult): void {
    if (!r.approved) return;
    if (this.consumed.has(r.planHash)) {
      throw new ApprovalError(`approval for plan ${r.planHash.slice(0, 8)} was already consumed`);
    }
    if (this.entries.has(r.planHash)) return;
    const now = this.clock.now().getTime();
    const at = Date.parse(r.at);
    const issued = Number.isFinite(at) && at <= now ? at : now;
    this.entries.set(r.planHash, { result: r, expiresAt: issued + this.ttlMs });
  }

  /** Single use. Throws if there is no live approval for this exact plan hash. */
  consume(hash: string): ApprovalResult {
    const e = this.entries.get(hash);
    if (!e) throw new ApprovalError(`no approval recorded for plan ${hash.slice(0, 8)}`);
    this.entries.delete(hash);
    this.consumed.add(hash);
    if (this.clock.now().getTime() >= e.expiresAt) {
      throw new ApprovalError(`approval for plan ${hash.slice(0, 8)} has expired`);
    }
    return e.result;
  }
}
