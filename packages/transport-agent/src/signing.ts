import { createHmac, createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { canonicalString, HEADERS, type SignableRequest } from '@auto-wp/contracts';

export type Algorithm = 'ed25519' | 'hmac-sha256';

// PKCS8 DER prefix for an Ed25519 private key; the 32-byte seed follows.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface Signer {
  readonly algorithm: Algorithm;
  sign(canonical: string): string;
}

/** Build a signer from the secret (base64 ed25519 seed, or base64 HMAC key). Errors never include the secret. */
export function createSigner(algorithm: Algorithm, secretB64: string): Signer {
  const raw = Buffer.from(secretB64.trim(), 'base64');
  if (algorithm === 'ed25519') {
    if (raw.length !== 32) throw new Error('ed25519 signing key must be a base64-encoded 32-byte seed');
    const key: KeyObject = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
      format: 'der',
      type: 'pkcs8',
    });
    return { algorithm, sign: (c) => sign(null, Buffer.from(c, 'utf8'), key).toString('base64') };
  }
  if (raw.length === 0) throw new Error('hmac signing key is empty');
  return { algorithm, sign: (c) => createHmac('sha256', raw).update(c, 'utf8').digest('base64') };
}

export function signedHeaders(signer: Signer, keyId: string, req: SignableRequest): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    [HEADERS.site]: req.siteId,
    [HEADERS.keyId]: keyId,
    [HEADERS.algorithm]: signer.algorithm,
    [HEADERS.timestamp]: String(req.timestamp),
    [HEADERS.nonce]: req.nonce,
    [HEADERS.signature]: signer.sign(canonicalString(req)),
  };
}
