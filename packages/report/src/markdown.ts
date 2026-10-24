import type {
  ArtifactView,
  BackupView,
  CheckView,
  ComparisonView,
  ItemView,
  ReportView,
  VulnRowView,
} from './view.js';

/** Escapes markdown syntax (and table pipes) in untrusted text and flattens line breaks. */
export function mdText(s: string): string {
  return s.replace(/[\\`*_[\]<>|~&]/g, '\\$&').replace(/\s*\r?\n\s*/g, ' ');
}

function mdLink(label: string, url: string): string {
  return `[${mdText(label)}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
}

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

function renderBackup(b: BackupView | undefined): string {
  if (!b) return 'No backup was recorded for this run.';
  const lines: string[] = [];
  lines.push(`- **Backup ID:** ${mdText(b.id ?? 'unknown')}`);
  if (b.location) lines.push(`- **Location:** ${mdText(b.location)}`);
  if (b.artifacts.length > 0) {
    lines.push('');
    lines.push(
      table(
        ['Artifact', 'Size', 'SHA-256'],
        b.artifacts.map((a: ArtifactView) => [
          `${mdText(a.name)}${a.encrypted ? ' (encrypted)' : ''}`,
          mdText(a.size),
          `\`${a.sha256}\``,
        ]),
      ),
    );
  }
  if (!b.verification) {
    lines.push('', '- **Verification:** not run');
  } else {
    const v = b.verification;
    lines.push('');
    lines.push(
      `- **Verification:** ${v.ok ? 'passed' : 'FAILED'} (${mdText(v.verifiedAt)}), ${v.total} checks`,
    );
    if (v.failing.length > 0) {
      lines.push(
        bullets(
          v.failing.map(
            (c: CheckView) =>
              `${mdText(c.name)} (${mdText(c.severity)})${c.details ? `: ${mdText(c.details)}` : ''}`,
          ),
        ),
      );
    }
  }
  return lines.join('\n');
}

function renderItem(item: ItemView): string {
  const lines = [`**Version:** ${mdText(item.change)}`, ''];
  if (item.rows.length === 0) {
    lines.push(
      item.errors.length > 0
        ? 'Vulnerability data is incomplete (see lookup errors).'
        : 'No known vulnerabilities.',
    );
  } else {
    lines.push(
      table(
        ['ID / CVE', 'Title', 'CVSS', 'Affected range', 'Fixed in', 'Fixed by this update'],
        item.rows.map((r: VulnRowView) => [
          r.link ? mdLink(r.label, r.link) : mdText(r.label),
          mdText(r.title),
          mdText(r.cvss),
          mdText(r.affected),
          mdText(r.fixedIn),
          r.stillAffectingNew ? '⚠ no' : r.fixedByUpdate ? 'yes' : 'no',
        ]),
      ),
    );
  }
  if (item.sources.length > 0) lines.push('', `Sources: ${mdText(item.sources.join(', '))}`);
  if (item.errors.length > 0) lines.push('', `Lookup errors:\n${bullets(item.errors.map(mdText))}`);
  return lines.join('\n');
}

function renderComparison(c: ComparisonView | undefined): string {
  if (!c) return 'No before/after comparison was recorded.';
  const lines = [`**Overall:** ${c.ok ? 'OK' : 'problems found'}`, ''];
  if (c.pages.length > 0) {
    lines.push(
      table(
        ['URL', 'Status before → after', 'Pixel diff', 'Slowdown', 'Problems'],
        c.pages.map((p) => [
          mdText(p.url),
          `${mdText(p.status)}${p.statusChanged ? ' ⚠' : ''}`,
          mdText(p.pixelDiff),
          mdText(p.slowdown),
          mdText(p.problems),
        ]),
      ),
    );
  } else {
    lines.push('No pages were compared.');
  }
  lines.push('', '**New log errors:**', '');
  lines.push(c.newLogErrors.length > 0 ? bullets(c.newLogErrors.map(mdText)) : 'None.');
  return lines.join('\n');
}

function renderFailed(view: ReportView): string {
  if (view.failed.length === 0) return 'No failed or rolled-back items.';
  return table(
    ['Item', 'Error', 'Outcome'],
    view.failed.map((f) => [mdText(f.item), mdText(f.error), mdText(f.outcome)]),
  );
}

function renderItems(items: ItemView[], empty: string): string {
  if (items.length === 0) return empty;
  return items.map((i) => `### ${mdText(i.name)} (${mdText(i.slug)})\n\n${renderItem(i)}`).join('\n\n');
}

export function renderMarkdown(view: ReportView): string {
  const parts = [
    `# ${mdText(view.title)}`,
    '',
    mdText(view.summary),
    `Site: ${mdText(view.siteUrl)}`,
    '',
    '## Backup',
    '',
    renderBackup(view.backup),
    '',
    '## 1. WordPress core',
    '',
    view.core ? renderItem(view.core) : 'Core was not updated.',
    '',
    '## 2. Themes',
    '',
    renderItems(view.themes, 'No themes were updated.'),
    '',
    '## 3. Plugins (updated only)',
    '',
    renderItems(view.plugins, 'No plugins were updated.'),
    '',
    '## Failed / rolled back',
    '',
    renderFailed(view),
    '',
    '## Before/after comparison',
    '',
    renderComparison(view.comparison),
    '',
    '## Attributions',
    '',
    view.attributions.length > 0 ? bullets(view.attributions.map(mdText)) : 'None.',
    '',
  ];
  return parts.join('\n');
}
