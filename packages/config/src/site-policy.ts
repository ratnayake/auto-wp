import {
  type AppConfig,
  type Policy,
  PolicySchema,
  type SiteConfig,
  SiteConfigSchema,
} from '@auto-wp/contracts';
import { ConfigError, formatIssues } from './errors.js';

type Overrides = Record<string, unknown>;

/**
 * `site.policy` holds only what the site sets explicitly, as validated but un-defaulted input.
 * The contracts schema types it as a full Policy and fills defaults into it; this package does not use
 * those defaults, so that app-level policy still applies to fields a site does not mention.
 * Use `resolveSitePolicy` to get the effective policy.
 */
export function parseSiteConfig(input: unknown): SiteConfig {
  const parsed = SiteConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(`invalid site:\n${formatIssues(parsed.error.issues)}`);
  return withExplicitPolicy(parsed.data, input);
}

/** Replaces the defaulted policy with the site's own (already validated) input. */
export function withExplicitPolicy(site: SiteConfig, rawSite: unknown): SiteConfig {
  const rawPolicy = isPlainObject(rawSite) ? rawSite.policy : undefined;
  const overrides = isPlainObject(rawPolicy) ? structuredClone(rawPolicy) : {};
  return { ...site, policy: overrides as Policy };
}

/**
 * Effective policy for one site: the app-level policy with the site's explicit overrides applied.
 * Objects merge field by field; arrays (e.g. `holds`) are replaced, not appended.
 */
export function resolveSitePolicy(app: AppConfig, site: SiteConfig): Policy {
  const overrides: Overrides = isPlainObject(site.policy) ? site.policy : {};
  const parsed = PolicySchema.safeParse(deepMerge(app.policy, overrides));
  if (!parsed.success) {
    throw new ConfigError(`invalid policy for site ${site.id}:\n${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, over: Overrides): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}
