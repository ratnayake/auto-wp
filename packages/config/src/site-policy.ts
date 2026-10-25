import {
  type AppConfig,
  mergePolicy,
  type Policy,
  type SiteConfig,
  SiteConfigSchema,
} from '@auto-wp/contracts';
import { ConfigError, formatIssues } from './errors.js';

/** Validates one site. `site.policy` holds only the overrides the site sets explicitly (no defaults). */
export function parseSiteConfig(input: unknown): SiteConfig {
  const parsed = SiteConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(`invalid site:\n${formatIssues(parsed.error.issues)}`);
  return parsed.data;
}

/**
 * Effective policy for one site: `mergePolicy(app.policy, site.policy)` from contracts. Objects merge field by
 * field; arrays (e.g. `holds`) are replaced, not appended.
 */
export function resolveSitePolicy(app: AppConfig, site: SiteConfig): Policy {
  return mergePolicy(app.policy, site.policy);
}
