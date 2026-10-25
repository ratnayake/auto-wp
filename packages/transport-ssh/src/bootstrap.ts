import { createHash } from 'node:crypto';

export type Fetcher = (url: string) => Promise<Buffer>;

export const WP_CLI_PHAR_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';

export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

export const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Downloads wp-cli.phar and verifies it against the published .sha512 file. */
export async function fetchWpCliPhar(fetcher: Fetcher, url = WP_CLI_PHAR_URL): Promise<Buffer> {
  const [phar, sumFile] = await Promise.all([fetcher(url), fetcher(`${url}.sha512`)]);
  const expected = sumFile.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!/^[0-9a-f]{128}$/.test(expected)) throw new Error('wp-cli.phar.sha512 is malformed');
  const actual = createHash('sha512').update(phar).digest('hex');
  if (actual !== expected) throw new Error('wp-cli.phar checksum mismatch; refusing to install');
  return phar;
}
