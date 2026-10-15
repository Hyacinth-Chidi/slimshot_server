import type { Readable } from 'node:stream';

import { StorageKind } from '../../generated/prisma/enums';

/**
 * Reads an uploaded object's real format (and, for audio, its length) from its
 * bytes. Throws UnreadableUploadError for content it does not accept.
 */
export type ContentInspector = (
  stream: Readable,
  size: number,
) => Promise<{ format: string; mimeType: string; durationMs?: number }>;

export interface UploadTicketInput {
  folder: string;
  filename: string;
  mimeType: string;
  /**
   * The exact size of the file, in bytes. Signed into the upload URL, so the
   * provider refuses a body of any other length: a leaked ticket cannot be used
   * to store something larger than what was approved.
   */
  byteSize: number;
  ttlSeconds: number;
}

export interface UploadTicket {
  /** Presigned URL: the client sends the file body here, with no other credentials. */
  uploadUrl: string;
  method: 'PUT';
  /** Headers the client must send exactly as given, or the signature does not match. */
  headers: Record<string, string>;
  storageKey: string;
  /** When the URL stops working; the provider enforces it. */
  expiresAt: Date;
}

/** Authoritative metadata read back from the provider after an upload. */
export interface RemoteObject {
  storageKey: string;
  byteSize: number;
  format: string;
  mimeType: string;
  durationMs?: number;
  width?: number;
  height?: number;
  checksumSha256?: string;
  deliveryUrl: string;
}

export interface StorageProviderAdapter {
  readonly id: string;
  readonly kind: StorageKind;
  createUploadTicket(input: UploadTicketInput): Promise<UploadTicket>;
  /**
   * Reads what actually landed and runs `inspect` over its bytes. Throws
   * UnreadableUploadError (from `inspect`) when the object exists but is not an
   * acceptable file; any other error means it could not be read at all
   * (missing, or storage unreachable).
   */
  verifyUpload(storageKey: string, inspect: ContentInspector): Promise<RemoteObject>;
  getDeliveryUrl(storageKey: string): string;
  getSignedUrl(storageKey: string, ttlSeconds: number): Promise<string>;
  delete(storageKey: string): Promise<void>;
}

/** The upload arrived, but its content is not something the catalogue accepts. */
export class UnreadableUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableUploadError';
  }
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Public custom domain of the bucket, no trailing slash. */
  publicBaseUrl: string;
}
