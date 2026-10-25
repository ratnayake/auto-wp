import type { Clock, ConnectionFactory, Logger, SecretStore, SiteConfig } from '@auto-wp/contracts';
import { type AgentConnectionDeps, AgentSiteConnection, type FetchLike } from './connection.js';

export interface AgentConnectionFactoryOptions {
  secrets: SecretStore;
  logger: Logger;
  clock?: Clock;
  fetch?: FetchLike;
  nonce?: () => string;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

export class AgentConnectionFactory implements ConnectionFactory {
  constructor(private readonly opts: AgentConnectionFactoryOptions) {}

  async open(site: SiteConfig): Promise<AgentSiteConnection> {
    if (site.transport.kind !== 'agent') {
      throw new Error(`AgentConnectionFactory cannot open a ${site.transport.kind} transport`);
    }
    const deps: AgentConnectionDeps = { ...this.opts, siteId: site.id, config: site.transport };
    return new AgentSiteConnection(deps);
  }
}
