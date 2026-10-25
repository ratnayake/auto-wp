import type { ConnectionFactory, SiteConfig, SiteConnection } from '@auto-wp/contracts';
import { type SshConnectionDeps, SshSiteConnection, type SshTransportConfig } from './connection.js';

export class SshConnectionFactory implements ConnectionFactory {
  constructor(private readonly deps: SshConnectionDeps) {}

  create(siteId: string, config: SshTransportConfig): SshSiteConnection {
    return new SshSiteConnection(siteId, config, this.deps);
  }

  /** Builds the connection and connects, so host-key or auth problems surface immediately. */
  async open(site: SiteConfig): Promise<SiteConnection> {
    if (site.transport.kind !== 'ssh') {
      throw new Error(`SshConnectionFactory cannot open a "${site.transport.kind}" transport`);
    }
    const conn = this.create(site.id, site.transport);
    try {
      await conn.connect();
    } catch (e) {
      await conn.close();
      throw e;
    }
    return conn;
  }
}
