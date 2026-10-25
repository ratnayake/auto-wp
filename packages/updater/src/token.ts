import { randomBytes } from 'node:crypto';

/** 32-char URL-safe random token (24 bytes of entropy), used as the maintenance-mode bypass token. */
export function randomBypassToken(): string {
  return randomBytes(24).toString('base64url');
}
