import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface PixelDiff {
  pct: number;
  diffPixels: number;
  diffPng: Buffer;
}

function pad(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  // Magenta filler so a height/width change always registers as a difference.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 0;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  PNG.bitblt(src, out, 0, 0, src.width, src.height, 0, 0);
  return out;
}

export function diffPngs(a: Buffer, b: Buffer): PixelDiff {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  const w = Math.max(pa.width, pb.width);
  const h = Math.max(pa.height, pb.height);
  const out = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(pad(pa, w, h).data, pad(pb, w, h).data, out.data, w, h, { threshold: 0.1 });
  const pct = w * h === 0 ? 0 : Math.round((diffPixels / (w * h)) * 10_000) / 100;
  return { pct, diffPixels, diffPng: PNG.sync.write(out) };
}

export async function diffPngFiles(beforePath: string, afterPath: string, outPath: string): Promise<number> {
  const d = diffPngs(await readFile(beforePath), await readFile(afterPath));
  if (d.diffPixels > 0) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, d.diffPng);
  }
  return d.pct;
}
