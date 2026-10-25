import type { Report, Reporter } from '@auto-wp/contracts';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';
import { type ImageReader, MAX_EMBED_BYTES, mimeForImage, readLocalImage } from './node-images.js';
import { buildView } from './view.js';

export interface DefaultReporterOptions {
  /** Injected for tests; defaults to reading local files. */
  readImage?: ImageReader;
}

export class DefaultReporter implements Reporter {
  private readonly readImage: ImageReader;

  constructor(options: DefaultReporterOptions = {}) {
    this.readImage = options.readImage ?? readLocalImage;
  }

  async render(r: Report, format: 'json' | 'md' | 'html'): Promise<string> {
    if (format === 'json') return `${JSON.stringify(r, null, 2)}\n`;
    const view = buildView(r);
    if (format === 'md') return renderMarkdown(view);
    const images = await this.embedImages(r);
    return renderHtml(view, images);
  }

  private async embedImages(r: Report): Promise<Map<string, string>> {
    const paths = new Set<string>();
    for (const page of r.comparison?.pages ?? []) {
      for (const p of Object.values(page.diffImagePaths ?? {})) paths.add(p);
    }
    const entries = await Promise.all(
      [...paths].map(async (path): Promise<[string, string] | undefined> => {
        const mime = mimeForImage(path);
        if (!mime) return undefined;
        try {
          const bytes = await this.readImage(path);
          if (!bytes || bytes.byteLength >= MAX_EMBED_BYTES) return undefined;
          return [path, `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`];
        } catch {
          // An unreadable screenshot is left out rather than failing the report.
          return undefined;
        }
      }),
    );
    return new Map(entries.filter((e): e is [string, string] => e !== undefined));
  }
}
