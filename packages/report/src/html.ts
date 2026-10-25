import { safeUrl } from './format.js';
import type { ArtifactView, BackupView, ComparisonView, ItemView, ReportView, VulnRowView } from './view.js';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d2327; --muted: #646970; --border: #dcdcde;
  --row: #f6f7f7; --warn: #b32d2e; --link: #2271b1; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #1d2327; --fg: #f0f0f1; --muted: #a7aaad; --border: #3c434a;
    --row: #2c3338; --warn: #ff8a8a; --link: #72aee6; }
}
:root[data-theme="dark"] { --bg: #1d2327; --fg: #f0f0f1; --muted: #a7aaad; --border: #3c434a;
  --row: #2c3338; --warn: #ff8a8a; --link: #72aee6; }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0 auto; max-width: 1100px; padding: 16px; }
h1 { font-size: 1.6rem; } h2 { font-size: 1.25rem; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
h3 { font-size: 1.05rem; }
.summary, .muted { color: var(--muted); }
a { color: var(--link); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
th, td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: var(--row); }
code { word-break: break-all; }
.warn { color: var(--warn); font-weight: 600; }
.fail { color: var(--warn); font-weight: 600; }
figure { margin: 8px 0; } figure img { max-width: 100%; height: auto; border: 1px solid var(--border); }
figcaption { color: var(--muted); font-size: 0.9em; }
`;

function linkOrText(label: string, url: string | undefined): string {
  return url ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
}

function table(headers: string[], rows: string[][]): string {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const cell = (html: string) => `<td>${html}</td>`;
const text = (s: string) => cell(esc(s));

function vulnTable(rows: VulnRowView[]): string {
  return table(
    ['ID / CVE', 'Title', 'CVSS', 'Affected range', 'Fixed in', 'Fixed by this update'],
    rows.map((r) => [
      cell(linkOrText(r.label, r.link)),
      text(r.title),
      text(r.cvss),
      text(r.affected),
      text(r.fixedIn),
      r.stillAffectingNew
        ? cell(`<span class="warn">⚠ no</span>`)
        : cell(r.fixUnknown ? 'unknown (lookup failed)' : r.fixedByUpdate ? 'yes' : 'no'),
    ]),
  );
}

function itemHtml(item: ItemView): string {
  const parts = [`<p><strong>Version:</strong> ${esc(item.change)}</p>`];
  if (item.rows.length > 0) {
    parts.push(vulnTable(item.rows));
  } else {
    parts.push(
      item.incomplete
        ? '<p class="warn">Vulnerability data is incomplete (see lookup errors).</p>'
        : '<p>No known vulnerabilities.</p>',
    );
  }
  if (item.sources.length > 0) parts.push(`<p class="muted">Sources: ${esc(item.sources.join(', '))}</p>`);
  if (item.errors.length > 0) {
    parts.push(
      `<p class="warn">Lookup errors:</p><ul>${item.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`,
    );
  }
  return parts.join('');
}

function backupHtml(b: BackupView | undefined): string {
  if (!b) return '<p>No backup was recorded for this run.</p>';
  const parts = [`<p><strong>Backup ID:</strong> ${esc(b.id ?? 'unknown')}</p>`];
  if (b.location) parts.push(`<p><strong>Location:</strong> <code>${esc(b.location)}</code></p>`);
  if (b.artifacts.length > 0) {
    parts.push(
      table(
        ['Artifact', 'Size', 'SHA-256'],
        b.artifacts.map((a: ArtifactView) => [
          text(`${a.name}${a.encrypted ? ' (encrypted)' : ''}`),
          text(a.size),
          cell(`<code>${esc(a.sha256)}</code>`),
        ]),
      ),
    );
  }
  if (!b.verification) {
    parts.push('<p><strong>Verification:</strong> not run</p>');
  } else {
    const v = b.verification;
    parts.push(
      `<p><strong>Verification:</strong> <span class="${v.ok ? '' : 'fail'}">${v.ok ? 'passed' : 'FAILED'}</span>` +
        ` (${esc(v.verifiedAt)}), ${v.total} checks</p>`,
    );
    if (v.failing.length > 0) {
      parts.push(
        `<ul>${v.failing
          .map(
            (c) =>
              `<li>${esc(c.name)} (${esc(c.severity)})${c.details ? `: <code>${esc(c.details)}</code>` : ''}</li>`,
          )
          .join('')}</ul>`,
      );
    }
  }
  return parts.join('');
}

function comparisonHtml(c: ComparisonView | undefined, images: ReadonlyMap<string, string>): string {
  if (!c) return '<p>No before/after comparison was recorded.</p>';
  const parts = [
    `<p><strong>Overall:</strong> ${c.ok ? 'OK' : '<span class="fail">problems found</span>'}</p>`,
  ];
  if (c.pages.length > 0) {
    parts.push(
      table(
        ['URL', 'Status before → after', 'Pixel diff', 'Slowdown', 'Problems'],
        c.pages.map((p) => [
          text(p.url),
          cell(`${esc(p.status)}${p.statusChanged ? ' <span class="warn">⚠</span>' : ''}`),
          text(p.pixelDiff),
          text(p.slowdown),
          text(p.problems),
        ]),
      ),
    );
    for (const page of c.pages) {
      for (const img of page.diffImages) {
        const src = images.get(img.path);
        if (!src) continue;
        const caption = `${page.url} (${img.device} diff)`;
        parts.push(
          `<figure><img src="${src}" alt="${esc(caption)}" loading="lazy"><figcaption>${esc(caption)}</figcaption></figure>`,
        );
      }
    }
  } else {
    parts.push('<p>No pages were compared.</p>');
  }
  parts.push('<h3>New log errors</h3>');
  parts.push(
    c.newLogErrors.length > 0
      ? `<ul>${c.newLogErrors.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul>`
      : '<p>None.</p>',
  );
  return parts.join('');
}

function itemsHtml(items: ItemView[], empty: string): string {
  if (items.length === 0) return `<p>${esc(empty)}</p>`;
  return items.map((i) => `<h3>${esc(i.name)} (${esc(i.slug)})</h3>${itemHtml(i)}`).join('');
}

/** `images` maps a diff image path to a ready-made `data:` URI; missing entries are skipped. */
export function renderHtml(view: ReportView, images: ReadonlyMap<string, string>): string {
  const failed =
    view.failed.length === 0
      ? '<p>No failed or rolled-back items.</p>'
      : table(
          ['Item', 'Error', 'Outcome'],
          view.failed.map((f) => [text(f.item), text(f.error), text(f.outcome)]),
        );
  const attributions =
    view.attributions.length > 0
      ? `<ul>${view.attributions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
      : '<p>None.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(view.title)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>${esc(view.title)}</h1>
<p class="summary">${esc(view.summary)}</p>
<p>Site: ${linkOrText(view.siteUrl, safeUrl(view.siteUrl))}</p>
<h2>Backup</h2>
${backupHtml(view.backup)}
<h2>1. WordPress core</h2>
${view.core ? itemHtml(view.core) : '<p>Core was not updated.</p>'}
<h2>2. Themes</h2>
${itemsHtml(view.themes, 'No themes were updated.')}
<h2>3. Plugins (updated only)</h2>
${itemsHtml(view.plugins, 'No plugins were updated.')}
<h2>Failed / rolled back</h2>
${failed}
<h2>Before/after comparison</h2>
${comparisonHtml(view.comparison, images)}
<h2>Attributions</h2>
${attributions}
</body>
</html>
`;
}
