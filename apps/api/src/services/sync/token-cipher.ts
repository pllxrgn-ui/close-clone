import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { oauthTokensSchema, type OAuthTokens } from '@switchboard/shared/providers';

/**
 * Authenticated encryption for the OAuth token bundle stored at rest in
 * `email_accounts.oauth_tokens` (CONTRACTS §C1 — "encrypted"). AES-256-GCM over
 * the JSON-serialised {@link OAuthTokens}; the wire format is a single base64url
 * string `v1.<iv>.<authTag>.<ciphertext>` so it fits the schema's `text` column.
 *
 * The 256-bit key is derived from a caller-supplied secret via SHA-256, so any
 * length secret works (the API session secret, a dedicated key env, or a test
 * constant). Decryption verifies the GCM tag before returning — a tampered or
 * truncated blob throws rather than yielding a partial token.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;
const VERSION = 'v1';

export class TokenDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenDecryptError';
  }
}

export class TokenCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length === 0) throw new Error('TokenCipher: empty secret');
    this.key = createHash('sha256').update(secret, 'utf8').digest();
  }

  /** Encrypt a token bundle to the storable `v1.<iv>.<tag>.<ct>` string. */
  encrypt(tokens: OAuthTokens): string {
    const validated = oauthTokensSchema.parse(tokens);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(validated), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /** Decrypt a stored blob back to a validated token bundle. */
  decrypt(blob: string): OAuthTokens {
    const parts = blob.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new TokenDecryptError('malformed token blob');
    }
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[2]!, 'base64url');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new TokenDecryptError('bad iv/tag length');
    }
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // GCM tag mismatch (wrong key or tampered blob).
      throw new TokenDecryptError('authentication failed');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new TokenDecryptError('decrypted payload is not JSON');
    }
    return oauthTokensSchema.parse(parsed);
  }

  /** Constant-time equality of two stored blobs' ciphertext (test affordance). */
  static blobsMatch(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
