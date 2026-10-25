import { readFile, stat } from 'node:fs/promises';

/** Diff screenshots at or above this size are not embedded. */
export const MAX_EMBED_BYTES = 2 * 1024 * 1024;

/** Reads an image for embedding. Returns undefined when it is missing or unreadable. */
export type ImageReader = (path: string) => Promise<Uint8Array | undefined>;

export const readLocalImage: ImageReader = async (path) => {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size >= MAX_EMBED_BYTES) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
};

export function mimeForImage(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return undefined;
}
