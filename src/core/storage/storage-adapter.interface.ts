import { StorageKind } from '../../generated/prisma/enums';

export interface UploadTicketInput {
  folder: string;
  filename: string;
  mimeType: string;
  ttlSeconds: number;
}

export interface UploadTicket {
  uploadUrl: string;
  storageKey: string;
  fields: Record<string, string>;
  /**
   * Advisory only. Cloudinary validates the signature against `timestamp` using its own
   * staleness window, so a ticket may remain usable after this passes. Callers must not
   * treat it as an enforced deadline.
   */
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
  verifyUpload(storageKey: string): Promise<RemoteObject>;
  getDeliveryUrl(storageKey: string): string;
  getSignedUrl(storageKey: string, ttlSeconds: number): Promise<string>;
  delete(storageKey: string): Promise<void>;
}

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}
