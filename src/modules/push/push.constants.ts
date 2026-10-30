export const QUEUE_PUSH = 'push';
export const JOB_SEND = 'send';

/** Firebase takes at most 500 tokens per multicast. */
export const PUSH_BATCH = 500;

export interface PushJob {
  messageId: string;
}

export interface PushPayload {
  title: string;
  body: string;
  messageId: string;
}

export interface PushBatchResult {
  sent: number;
  failed: number;
  /** Tokens Firebase says will never work again (app uninstalled, token replaced). */
  deadTokens: string[];
}

/** Sends one batch. Firebase in production; tests stand in for it. */
export interface PushSender {
  send(tokens: string[], payload: PushPayload): Promise<PushBatchResult>;
}

/** `PushSender`, or null until FIREBASE_SERVICE_ACCOUNT_BASE64 is set. */
export const PUSH_SENDER = Symbol('PUSH_SENDER');
