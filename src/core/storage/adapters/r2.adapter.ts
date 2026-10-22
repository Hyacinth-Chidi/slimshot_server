import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { StorageKind } from '../../../generated/prisma/enums';
import {
  ContentInspector,
  R2Config,
  RemoteObject,
  StorageProviderAdapter,
  UploadTicket,
  UploadTicketInput,
} from '../storage-adapter.interface';

/** The one client method the adapter calls; tests pass a stand-in. */
interface CommandSender {
  send(command: unknown): Promise<unknown>;
}

interface R2Deps {
  client?: CommandSender;
}

function buildClient(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto', // required by the SDK, ignored by R2
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // <account>.r2.cloudflarestorage.com/<bucket>/<key>: one host whatever the
    // bucket is called (a dotted name breaks TLS on the bucket-subdomain form).
    forcePathStyle: true,
    // By default the SDK signs a CRC32 of the (empty) body into presigned URLs,
    // which a browser upload can never match. Checksums only where R2 needs them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // A stalled connection fails finalize after 30 s of silence instead of
    // holding the request open indefinitely.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  });
}

/** ".mp3" from "Track.MP3"; nothing when the name has no plain extension. */
function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(filename);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function isMissing(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Cloudflare R2 through its S3-compatible API. The dashboard uploads straight
 * to the bucket with a presigned PUT; the app downloads from the bucket's
 * public domain, where R2 charges nothing for bandwidth.
 */
export class R2Adapter implements StorageProviderAdapter {
  readonly kind = StorageKind.r2;
  private readonly client: CommandSender;

  constructor(
    readonly id: string,
    private readonly config: R2Config,
    deps: R2Deps = {},
  ) {
    this.client = deps.client ?? buildClient(config);
  }

  async createUploadTicket(input: UploadTicketInput): Promise<UploadTicket> {
    // A fresh key every time, and the PUT is create-only (If-None-Match: *):
    // once the file exists, R2 answers 412 to the same URL, so a leaked ticket
    // cannot swap a checked, catalogued file for other bytes before it expires.
    const storageKey = `${input.folder}/${randomUUID()}${extensionOf(input.filename)}`;

    const uploadUrl = await getSignedUrl(
      this.client as S3Client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
        ContentType: input.mimeType,
        ContentLength: input.byteSize,
        IfNoneMatch: '*',
      }),
      {
        expiresIn: input.ttlSeconds,
        // content-length is signed by default; the others only when asked.
        // All signed, R2 refuses any other size or type, and any overwrite.
        signableHeaders: new Set(['content-type', 'if-none-match']),
      },
    );

    return {
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': input.mimeType, 'If-None-Match': '*' },
      storageKey,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    };
  }

  async verifyUpload(storageKey: string, inspect: ContentInspector): Promise<RemoteObject> {
    let object: { Body?: unknown; ContentLength?: number };
    try {
      object = (await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: storageKey }),
      )) as typeof object;
    } catch (error) {
      if (isMissing(error)) throw new Error(`Uploaded object not found in storage: ${storageKey}`);
      throw error;
    }

    const byteSize = object.ContentLength ?? 0;
    const { format, mimeType, durationMs, details } = await inspect(object.Body as Readable, byteSize);

    return {
      storageKey,
      byteSize,
      format,
      mimeType,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(details !== undefined ? { details } : {}),
      deliveryUrl: this.getDeliveryUrl(storageKey),
    };
  }

  getDeliveryUrl(storageKey: string): string {
    const path = storageKey.split('/').map(encodeURIComponent).join('/');
    return `${this.config.publicBaseUrl}/${path}`;
  }

  async getSignedUrl(storageKey: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client as S3Client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: storageKey }),
      { expiresIn: ttlSeconds },
    );
  }

  async delete(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: storageKey }));
  }
}
