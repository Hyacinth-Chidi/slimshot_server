import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import type { FirebaseServiceAccount } from '../../config/env.validation';
import type { PushBatchResult, PushPayload, PushSender } from './push.constants';

const APP_NAME = 'slimshot-push';

// Firebase's word for a token that will never work again; anything else may pass.
const GONE = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

/** Sends through Firebase Cloud Messaging with the service account from FIREBASE_SERVICE_ACCOUNT_BASE64. */
export class FirebasePushSender implements PushSender {
  private readonly app: App;

  constructor(account: FirebaseServiceAccount) {
    this.app =
      getApps().find((a) => a.name === APP_NAME) ??
      initializeApp({ credential: cert(account), projectId: account.projectId }, APP_NAME);
  }

  async send(tokens: string[], payload: PushPayload): Promise<PushBatchResult> {
    const result = await getMessaging(this.app).sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: { messageId: payload.messageId },
    });
    const deadTokens = result.responses.flatMap((r, i) => (!r.success && r.error && GONE.has(r.error.code) ? [tokens[i]] : []));
    return { sent: result.successCount, failed: result.failureCount, deadTokens };
  }
}
