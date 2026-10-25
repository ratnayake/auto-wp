import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SITE_YAML = `
id: blog
name: Blog
url: https://blog.example.com
transport:
  kind: ssh
  host: blog.example.com
  username: deploy
  hostKeySha256: SHA256:abcDEF+/0123==
  wpRoot: /home/deploy/public_html
`;

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'autowp-config-'));
}

export function newKeyBase64(): string {
  return randomBytes(32).toString('base64');
}
