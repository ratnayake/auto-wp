// Generates test-vectors.json for the agent signing protocol. Deterministic: fixed seed, fixed inputs.
// Ed25519 signatures are deterministic (RFC 8032), so re-running yields identical output.
import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12);
const hmacKey = Buffer.from('auto-wp-test-hmac-key-0123456789abcdef', 'utf8');

const canonical = (r) =>
  [
    'AUTOWP-SIG-V1',
    r.method.toUpperCase(),
    r.path,
    String(r.timestamp),
    r.nonce,
    r.siteId,
    createHash('sha256').update(r.body).digest('hex'),
  ].join('\n');

const base = { method: 'POST', path: '/auto-wp-agent/agent.php', siteId: 'site-agent' };
const now = 1793000000; // fixed "server time" for the verification cases
const reqs = [
  {
    name: 'probe',
    ...base,
    timestamp: now,
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
    body: '{"action":"probe","params":{}}',
  },
  {
    name: 'db-dump',
    ...base,
    timestamp: now - 10,
    nonce: 'EBESExQVFhcYGRobHB0eHw',
    body: '{"action":"db.dump","params":{"dest":"auto-wp-backup/20261024T103012Z-7f3a9c/db.sql.gz","excludeTables":[]}}',
  },
  {
    name: 'unicode-body',
    ...base,
    timestamp: now + 5,
    nonce: 'ICEiIyQlJicoKSorLC0uLw',
    body: '{"action":"fs.stat","params":{"path":"wp-content/uploads/ünïcødé.txt"}}',
  },
];

const vectors = reqs.map((r) => {
  const c = canonical(r);
  return {
    ...r,
    canonical: c,
    ed25519SignatureB64: sign(null, Buffer.from(c), priv).toString('base64'),
    hmacSha256SignatureB64: createHmac('sha256', hmacKey).update(c).digest('base64'),
  };
});

const probe = vectors[0];
const rejections = [
  {
    name: 'timestamp-too-old',
    request: { ...probe, timestamp: now - 301 },
    signWith: 'valid',
    expect: 'reject',
  },
  {
    name: 'timestamp-too-new',
    request: { ...probe, timestamp: now + 301 },
    signWith: 'valid',
    expect: 'reject',
  },
  {
    name: 'timestamp-edge-ok',
    request: { ...probe, timestamp: now - 300 },
    signWith: 'valid',
    expect: 'accept',
  },
  {
    name: 'tampered-body',
    request: { ...probe, body: '{"action":"probe","params":{"x":1}}' },
    signWith: 'original',
    expect: 'reject',
  },
  { name: 'wrong-site', request: { ...probe, siteId: 'other-site' }, signWith: 'original', expect: 'reject' },
  { name: 'replayed-nonce', request: probe, signWith: 'original', replay: true, expect: 'reject-second' },
  { name: 'bad-nonce-format', request: { ...probe, nonce: 'short' }, signWith: 'valid', expect: 'reject' },
  { name: 'unknown-key-id', request: probe, keyId: 'nope', signWith: 'original', expect: 'reject' },
].map((x) => {
  const req = { ...x.request };
  delete req.canonical;
  delete req.ed25519SignatureB64;
  delete req.hmacSha256SignatureB64;
  delete req.name;
  const c = canonical(req);
  const sigSource = x.signWith === 'valid' ? c : probe.canonical;
  return {
    ...x,
    request: {
      ...req,
      canonical: c,
      ed25519SignatureB64: sign(null, Buffer.from(sigSource), priv).toString('base64'),
      hmacSha256SignatureB64: createHmac('sha256', hmacKey).update(sigSource).digest('base64'),
    },
  };
});

const out = {
  description:
    'Agent signing protocol test vectors. See docs/agent-protocol.md. Regenerate: pnpm -F @auto-wp/contracts gen:vectors',
  serverTime: now,
  clockSkewSec: 300,
  keyId: 'test-key-1',
  ed25519: { seedB64: seed.toString('base64'), publicKeyB64: Buffer.from(pub).toString('base64') },
  hmac: { keyB64: hmacKey.toString('base64') },
  requests: vectors,
  rejections,
};
writeFileSync(new URL('../test-vectors.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors, ${rejections.length} rejection cases`);
