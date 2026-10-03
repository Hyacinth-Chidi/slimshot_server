import { Inject, Injectable } from '@nestjs/common';
import { createPublicKey, type KeyObject, verify } from 'node:crypto';

import { admobConfig, type AdmobConfig } from '../../config';

/** The callback was not signed by AdMob (or not by a key AdMob publishes). */
export class SsvSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsvSignatureError';
  }
}

export interface SsvCallback {
  adUnit: string;
  customData: string;
  userId: string;
  transactionId: string;
  rewardAmount: string;
  timestamp: string;
  keyId: string;
}

const KEYS_TTL_MS = 24 * 3_600_000; // AdMob: never cache the keys for longer than 24 hours
const REFETCH_GAP_MS = 60_000;

/**
 * Verifies AdMob rewarded-ad server-side verification callbacks: ECDSA over
 * the query string up to "&signature=", with AdMob's published public keys.
 */
@Injectable()
export class AdmobVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private lastFetch = 0;

  constructor(@Inject(admobConfig.KEY) private readonly cfg: AdmobConfig) {}

  async verify(rawQuery: string): Promise<SsvCallback> {
    const cut = rawQuery.indexOf('&signature=');
    if (cut < 0) throw new SsvSignatureError('The callback has no signature.');
    const content = rawQuery.slice(0, cut);
    const tail = new URLSearchParams(rawQuery.slice(cut + 1));
    const signature = tail.get('signature');
    const keyId = tail.get('key_id');
    if (!signature || !keyId) throw new SsvSignatureError('The callback has no signature.');

    const key = await this.key(keyId);
    const valid = verify(
      'sha256',
      Buffer.from(content, 'utf8'),
      { key, dsaEncoding: 'der' },
      Buffer.from(signature, 'base64url'),
    );
    if (!valid) throw new SsvSignatureError('The callback signature does not match.');

    const p = new URLSearchParams(content);
    return {
      adUnit: p.get('ad_unit') ?? '',
      customData: p.get('custom_data') ?? '',
      userId: p.get('user_id') ?? '',
      transactionId: p.get('transaction_id') ?? '',
      rewardAmount: p.get('reward_amount') ?? '',
      timestamp: p.get('timestamp') ?? '',
      keyId,
    };
  }

  private async key(keyId: string): Promise<KeyObject> {
    let refreshed = false;
    if (Date.now() - this.fetchedAt > KEYS_TTL_MS) {
      await this.refresh();
      refreshed = true;
    }
    // A key AdMob added since our last fetch: look once more, but not on every bad request.
    if (!this.keys.has(keyId) && !refreshed && Date.now() - this.lastFetch > REFETCH_GAP_MS) {
      await this.refresh();
    }
    const key = this.keys.get(keyId);
    if (!key) throw new SsvSignatureError(`Unknown AdMob key ${keyId}.`);
    return key;
  }

  private async refresh(): Promise<void> {
    this.lastFetch = Date.now();
    const res = await fetch(this.cfg.verifierKeysUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Could not load AdMob verifier keys (HTTP ${res.status}).`);
    const body = (await res.json()) as { keys?: Array<{ keyId: number | string; pem?: string }> };
    const keys = new Map<string, KeyObject>();
    for (const k of body.keys ?? []) {
      if (k.pem) keys.set(String(k.keyId), createPublicKey(k.pem));
    }
    this.keys = keys;
    this.fetchedAt = Date.now();
  }
}
