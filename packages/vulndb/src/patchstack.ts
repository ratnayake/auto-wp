import type { ItemType, Vulnerability, VulnProvider } from '@auto-wp/contracts';
import { ProviderNotConfiguredError } from './errors.js';

/** Placeholder: Patchstack requires a commercial API agreement. */
export class PatchstackProvider implements VulnProvider {
  readonly name = 'patchstack' as const;
  async lookup(_type: ItemType, _slug: string): Promise<Vulnerability[]> {
    throw new ProviderNotConfiguredError('Patchstack provider is not configured');
  }
}
