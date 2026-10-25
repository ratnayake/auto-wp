import { SecretRefSchema } from '@auto-wp/contracts';
import { formatIssues, SecretStoreError } from './errors.js';

/** Validates `secret:<name>` and returns the name (the part after the prefix). */
export function secretNameOf(ref: string): string {
  const parsed = SecretRefSchema.safeParse(ref);
  if (!parsed.success)
    throw new SecretStoreError(`invalid secret ref:\n${formatIssues(parsed.error.issues)}`);
  return parsed.data.slice('secret:'.length);
}
