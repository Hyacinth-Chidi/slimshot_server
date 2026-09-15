import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const MASTER_KEY = Symbol('MASTER_KEY');

export interface SealedValue {
  cipher: Buffer;
  keyVersion: number;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CURRENT_KEY_VERSION = 1;

@Injectable()
export class EnvelopeCryptoService {
  private readonly key: Buffer;

  constructor(@Inject(MASTER_KEY) masterKeyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
      throw new Error(
        'MASTER_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).',
      );
    }
    this.key = Buffer.from(masterKeyHex, 'hex');
  }

  /** Layout: [12-byte IV][16-byte auth tag][ciphertext] */
  encrypt(plaintext: string): SealedValue {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      cipher: Buffer.concat([iv, cipher.getAuthTag(), body]),
      keyVersion: CURRENT_KEY_VERSION,
    };
  }

  decrypt(sealed: SealedValue): string {
    const iv = sealed.cipher.subarray(0, IV_BYTES);
    const tag = sealed.cipher.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = sealed.cipher.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  /** Display form for the admin API. Never reversible. */
  mask(plaintext: string): string {
    if (plaintext.length <= 8) return '••••';
    return `${plaintext.slice(0, 8)}••••${plaintext.slice(-4)}`;
  }
}
