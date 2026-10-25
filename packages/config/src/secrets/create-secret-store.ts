import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SecretStore } from '@auto-wp/contracts';
import { errorCode, SecretStoreError } from '../errors.js';
import { expandHome } from '../paths.js';
import { EncryptedFileSecretStore } from './encrypted-file-store.js';
import { KeyringSecretStore } from './keyring-store.js';

export const SECRETS_KEY_ENV = 'AUTOWP_SECRETS_KEY';
export const SECRETS_KEY_FILE_ENV = 'AUTOWP_SECRETS_KEY_FILE';
/** Name of the systemd credential (`LoadCredentialEncrypted=autowp-secrets-key:...`). */
export const SYSTEMD_KEY_CREDENTIAL = 'autowp-secrets-key';

type Env = Record<string, string | undefined>;

export interface SecretStoreOptions {
  /** `keyring`: OS keychain. `encrypted-file`: libsodium file. `auto` (default): file when a key is available, else keychain. */
  backend?: 'auto' | 'keyring' | 'encrypted-file';
  /** Encrypted file location. Default `~/.local/share/auto-wp/secrets.enc`. */
  secretsFile?: string;
  /** Explicit key file. Overrides the env-based lookup. */
  keyFile?: string;
  env?: Env;
}

/**
 * Base64 key from, in order: `AUTOWP_SECRETS_KEY`, the key file (`opts.keyFile`, `AUTOWP_SECRETS_KEY_FILE`,
 * or `$CREDENTIALS_DIRECTORY/autowp-secrets-key`). Returns undefined when none is configured.
 */
export function loadSecretsKey(opts: { keyFile?: string; env?: Env } = {}): string | undefined {
  const env = opts.env ?? process.env;
  const fromEnv = env[SECRETS_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;

  const explicit = opts.keyFile ?? env[SECRETS_KEY_FILE_ENV];
  if (explicit) return readKeyFile(expandHome(explicit));

  const credDir = env.CREDENTIALS_DIRECTORY;
  if (credDir) {
    const candidate = join(credDir, SYSTEMD_KEY_CREDENTIAL);
    if (existsSync(candidate)) return readKeyFile(candidate);
  }
  return undefined;
}

function readKeyFile(path: string): string {
  let key: string;
  try {
    key = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new SecretStoreError(`secrets key file ${path} could not be read (${errorCode(err) ?? 'error'})`);
  }
  if (key === '') throw new SecretStoreError(`secrets key file ${path} is empty`);
  return key;
}

/** Picks a SecretStore backend. Throws a SecretStoreError if the chosen backend cannot be set up. */
export function createSecretStore(opts: SecretStoreOptions = {}): SecretStore {
  const env = opts.env ?? process.env;
  const key = loadSecretsKey({ keyFile: opts.keyFile, env });
  const backend = opts.backend ?? 'auto';

  if (backend === 'keyring' || (backend === 'auto' && key === undefined)) return new KeyringSecretStore();

  if (key === undefined) {
    throw new SecretStoreError(
      `encrypted-file secret store needs a key: set ${SECRETS_KEY_ENV}, ${SECRETS_KEY_FILE_ENV}, ` +
        `or provide $CREDENTIALS_DIRECTORY/${SYSTEMD_KEY_CREDENTIAL}`,
    );
  }
  const path = expandHome(opts.secretsFile ?? join(homedir(), '.local/share/auto-wp/secrets.enc'));
  return new EncryptedFileSecretStore({ path, keyBase64: key });
}
