import { createHash } from 'node:crypto';

/**
 * Agent wire protocol helpers (see docs/agent-protocol.md). The PHP agent re-implements the same
 * canonicalisation; test-vectors.json pins both implementations.
 */

export const SIG_VERSION = 'AUTOWP-SIG-V1';
export const CLOCK_SKEW_SEC = 300;
export const NONCE_TTL_SEC = 600;
export const MAINTENANCE_BYPASS_COOKIE = 'autowp_bypass';

export const HEADERS = {
  site: 'X-AutoWP-Site',
  keyId: 'X-AutoWP-Key-Id',
  timestamp: 'X-AutoWP-Timestamp',
  nonce: 'X-AutoWP-Nonce',
  signature: 'X-AutoWP-Signature',
  algorithm: 'X-AutoWP-Alg',
} as const;

export interface SignableRequest {
  method: string;
  /** URL path only, no query string, e.g. `/auto-wp-agent/agent.php`. */
  path: string;
  /** Unix seconds. */
  timestamp: number;
  /** 16 random bytes, base64url without padding (22 chars). */
  nonce: string;
  siteId: string;
  body: string | Buffer;
}

export function canonicalString(r: SignableRequest): string {
  const bodyHash = createHash('sha256').update(r.body).digest('hex');
  return [SIG_VERSION, r.method.toUpperCase(), r.path, String(r.timestamp), r.nonce, r.siteId, bodyHash].join(
    '\n',
  );
}

/** Request body: `{"action": ..., "params": {...}}`. */
export interface AgentRequestBody {
  action: string;
  params: unknown;
}

/** Response body. A long-running action may return `job` instead of `result`; poll with `job.status`. */
export type AgentResponseBody =
  | { ok: true; result: unknown }
  | { ok: true; job: { jobId: string } }
  | { ok: false; error: { code: string; message: string } };

export const AGENT_ERROR_CODES = [
  'bad_request',
  'unknown_action',
  'invalid_params',
  'path_jail',
  'not_found',
  'capability',
  'wp_fatal',
  'locked',
  'internal',
] as const;
