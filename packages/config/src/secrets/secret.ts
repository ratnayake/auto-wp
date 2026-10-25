import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /password|passwd|secret|token|api[_-]?key|privatekey|authorization|cookie|credential/i;

/** Holds a secret value. Every serialisation path (toString, JSON, util.inspect) yields a placeholder. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}

/**
 * Deep copy of `value` with secret-looking properties replaced by a placeholder, for logs and errors.
 * Keys ending in `Ref` hold `secret:` references, not values, so they are kept.
 */
export function redact(value: unknown): unknown {
  if (value instanceof Secret) return REDACTED;
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Map) return redact(Object.fromEntries(value));
  if (typeof value !== 'object' || value === null || value instanceof Error || value instanceof Date) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) && !/ref$/i.test(k) ? REDACTED : redact(v);
  }
  return out;
}
