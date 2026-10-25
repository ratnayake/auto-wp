import { createHash } from 'node:crypto';
import {
  type ApprovalResult,
  type BackupCreateOptions,
  type BackupManifest,
  type BackupService,
  type BackupVerifier,
  type Capabilities,
  type Clock,
  type ComparisonResult,
  type HealthChecker,
  type HealthSnapshot,
  type InventoryService,
  type ItemResult,
  type ItemVulnAssessment,
  itemKey,
  type Policy,
  type Report,
  type Reporter,
  type RestorePlan,
  type RestoreService,
  type SiteConfig,
  type SiteConnection,
  type Thresholds,
  TOOL_VERSION,
  type UpdateItem,
  type Updater,
  type UpdaterOptions,
  type VerificationResult,
  type VulnService,
} from '@auto-wp/contracts';

/** In-package stand-ins used by createFakeServices(); the real packages replace them in wire.ts. */

export class StubBackupService implements BackupService {
  readonly backups = new Map<string, BackupManifest[]>();
  private n = 0;
  constructor(private readonly clock: Clock) {}

  async create(site: SiteConfig, _c: SiteConnection, o?: BackupCreateOptions): Promise<BackupManifest> {
    o?.onProgress?.('dumping database');
    o?.onProgress?.('archiving files');
    const createdAt = this.clock.now().toISOString();
    const backupId = `${createdAt.replace(/[-:]/g, '').replace(/\.\d+/, '')}-${(++this.n).toString(16).padStart(6, '0')}`;
    const sha256 = createHash('sha256').update(backupId).digest('hex');
    const manifest: BackupManifest = {
      schemaVersion: 1,
      backupId,
      siteId: site.id,
      createdAt,
      toolVersion: TOOL_VERSION,
      location: `/var/www/html/auto-wp-backup/${backupId}`,
      wp: { core: '6.7.1', php: '8.2.0', db: '8.0' },
      method: { db: 'wpcli', files: 'tar' },
      db: { tables: [{ name: 'wp_options', rows: 10 }], charset: 'utf8mb4' },
      files: { count: 3, bytes: 1024, excludes: [] },
      artifacts: [
        { name: 'db.sql.gz', bytes: 512, sha256 },
        { name: 'files.tar.gz', bytes: 512, sha256 },
      ],
    };
    if (!o?.dryRun) this.backups.set(site.id, [...(this.backups.get(site.id) ?? []), manifest]);
    return manifest;
  }

  async list(site: SiteConfig): Promise<BackupManifest[]> {
    return [...(this.backups.get(site.id) ?? [])];
  }

  async pull(_site: SiteConfig, _c: SiteConnection, backupId: string): Promise<{ localDir: string }> {
    return { localDir: `/tmp/auto-wp-fake/${backupId}` };
  }

  async prune(
    site: SiteConfig,
    _c: SiteConnection,
    keep: number,
    o?: { dryRun?: boolean },
  ): Promise<{ removed: string[] }> {
    const all = this.backups.get(site.id) ?? [];
    const removed = all.slice(0, Math.max(0, all.length - keep));
    if (!o?.dryRun) this.backups.set(site.id, all.slice(removed.length));
    return { removed: removed.map((b) => b.backupId) };
  }
}

export class StubVerifier implements BackupVerifier {
  constructor(
    private readonly backup: StubBackupService,
    private readonly clock: Clock,
  ) {}
  async verify(site: SiteConfig, _c: SiteConnection, backupId: string): Promise<VerificationResult> {
    const exists = (this.backup.backups.get(site.id) ?? []).some((b) => b.backupId === backupId);
    return {
      backupId,
      ok: exists,
      verifiedAt: this.clock.now().toISOString(),
      checks: [{ name: 'manifest-present', ok: exists, severity: exists ? 'info' : 'error' }],
    };
  }
}

const DEFAULT_ITEMS: UpdateItem[] = [
  item('core', 'wordpress', 'WordPress', '6.7.1', '6.8.0', true),
  item('theme', 'twentytwentyfour', 'Twenty Twenty-Four', '1.0', '1.1', false),
  item('plugin', 'contact-form-7', 'Contact Form 7', '5.8', '5.9', false),
  item('plugin', 'akismet', 'Akismet', '5.2', '5.3', false),
  item('plugin', 'broken-plugin', 'Broken Plugin', '1.0', '1.1', false),
];

function item(
  type: UpdateItem['type'],
  slug: string,
  name: string,
  currentVersion: string,
  newVersion: string,
  isMajor: boolean,
): UpdateItem {
  return { type, slug, name, currentVersion, newVersion, active: true, source: 'wporg', isMajor };
}

export class StubInventory implements InventoryService {
  constructor(private readonly items: UpdateItem[] = DEFAULT_ITEMS) {}
  async detect(): Promise<UpdateItem[]> {
    return this.items.map((i) => ({ ...i }));
  }
  plan(items: UpdateItem[], _caps: Capabilities, policy: Policy): UpdateItem[] {
    return items.map((i) => {
      if (policy.holds.includes(itemKey(i))) return { ...i, heldReason: 'held by policy' };
      if (!i.active && !policy.updateInactive) return { ...i, heldReason: 'inactive' };
      return { ...i };
    });
  }
}

export class StubVulnService implements VulnService {
  async assess(items: UpdateItem[]): Promise<ItemVulnAssessment[]> {
    return items.map((i) => ({ item: i, affectingOld: [], stillAffectingNew: [], sources: [], errors: [] }));
  }
  attributions(): string[] {
    return ['Vulnerability data: stub provider'];
  }
}

export class StubHealth implements HealthChecker {
  private n = 0;
  constructor(private readonly clock: Clock) {}
  async snapshot(site: SiteConfig, _c: SiteConnection, label: string): Promise<HealthSnapshot> {
    return {
      snapshotId: `snap-${++this.n}`,
      siteId: site.id,
      label,
      takenAt: this.clock.now().toISOString(),
      pages: [],
      logOffsets: {},
    };
  }
  async quick(): Promise<ComparisonResult> {
    return { ok: true, pages: [], newLogErrors: [] };
  }
  async compare(_b: HealthSnapshot, _a: HealthSnapshot, _t: Thresholds): Promise<ComparisonResult> {
    return { ok: true, pages: [], newLogErrors: [] };
  }
}

/** Fails any item whose slug starts with `broken` (rolled back), updates everything else. */
export class StubUpdater implements Updater {
  constructor(private readonly clock: Clock) {}
  async *apply(
    _site: SiteConfig,
    _c: SiteConnection,
    plan: UpdateItem[],
    o: UpdaterOptions,
  ): AsyncIterable<ItemResult> {
    for (const it of plan) {
      const startedAt = this.clock.now().toISOString();
      const base = { item: it, startedAt, finishedAt: startedAt };
      if (o.dryRun) {
        yield {
          ...base,
          outcome: 'dry-run',
          operations: [`would update ${itemKey(it)} to ${it.newVersion}`],
        };
      } else if (it.slug.startsWith('broken')) {
        yield { ...base, outcome: 'failed-rolled-back', error: 'health check failed', operations: [] };
      } else {
        yield { ...base, outcome: 'updated', installedVersion: it.newVersion, operations: [] };
      }
    }
  }
}

export class StubRestore implements RestoreService {
  constructor(private readonly clock: Clock) {}
  async plan(
    site: SiteConfig,
    _c: SiteConnection,
    backupId: string,
    scope: RestorePlan['scope'],
  ): Promise<RestorePlan> {
    const steps = [
      'enable maintenance mode',
      ...(scope !== 'files' ? ['import database dump'] : []),
      ...(scope !== 'db' ? ['extract files archive'] : []),
      'disable maintenance mode',
    ];
    const planHash = createHash('sha256')
      .update(JSON.stringify({ s: site.id, backupId, scope, steps }))
      .digest('hex');
    return { planHash, siteId: site.id, backupId, scope, steps, createdAt: this.clock.now().toISOString() };
  }
  async execute(
    _site: SiteConfig,
    _c: SiteConnection,
    plan: RestorePlan,
    approval: ApprovalResult,
  ): Promise<VerificationResult> {
    if (!approval.approved || approval.planHash !== plan.planHash) throw new Error('restore not approved');
    return { backupId: plan.backupId, ok: true, verifiedAt: this.clock.now().toISOString(), checks: [] };
  }
}

export class StubReporter implements Reporter {
  async render(r: Report, format: 'json' | 'md' | 'html'): Promise<string> {
    if (format === 'json') return JSON.stringify(r, null, 2);
    const lines = [`# Update report: ${r.site.name}`, '', `Run ${r.run.runId} (${r.run.status})`, ''];
    const section = (title: string, xs: ItemVulnAssessment[]) => {
      lines.push(`## ${title}`);
      if (xs.length === 0) lines.push('- none');
      for (const a of xs) {
        lines.push(`- ${a.item.name}: ${a.item.currentVersion} -> ${a.item.newVersion}`);
      }
      lines.push('');
    };
    section('Core', r.core ? [r.core] : []);
    section('Themes', r.themes);
    section('Plugins updated', r.plugins);
    lines.push('## Failed');
    if (r.failed.length === 0) lines.push('- none');
    for (const f of r.failed) lines.push(`- ${f.item.name}: ${f.outcome} ${f.error ?? ''}`.trim());
    const md = lines.join('\n');
    return format === 'html' ? `<pre>${md.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>` : md;
  }
}
