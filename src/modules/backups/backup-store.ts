import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { buildR2Client, type CommandSender } from '../../core/storage/adapters/r2.adapter';
import type { R2Config } from '../../core/storage/storage-adapter.interface';
import { BACKUP_PREFIX, type BackupItem, parseBackupFilename } from './backup-rules';

type R2Credentials = Pick<R2Config, 'accountId' | 'accessKeyId' | 'secretAccessKey'>;

interface ListPage {
  Contents?: { Key?: string; Size?: number }[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

// An upload of a large dump can go quiet for a while between chunks; 30 s is for small files.
const REQUEST_TIMEOUT_MS = 600_000;

/**
 * The private backup bucket. Backups live under `postgres/`, named by backup-rules; the
 * bucket is the only record of them, so the list is read from it every time.
 */
export class BackupStore {
  private readonly signer: S3Client;
  private readonly client: CommandSender;

  constructor(
    creds: R2Credentials,
    private readonly bucket: string,
    client?: CommandSender,
  ) {
    // Presigning needs a real client but no network, so tests stand in for `send` only.
    this.signer = buildR2Client(creds, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    this.client = client ?? this.signer;
  }

  /** Streams the file at `filePath` to the bucket as `filename`. */
  async upload(filePath: string, filename: string, metadata: Record<string, string>): Promise<{ sizeBytes: number }> {
    const key = this.keyOf(filename);
    const { size } = await stat(filePath);
    const body = createReadStream(filePath);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: size,
          ContentType: 'application/octet-stream',
          Metadata: metadata,
        }),
      );
    } finally {
      // A request that fails before reading the file would otherwise hold it open for good.
      body.destroy();
    }
    return { sizeBytes: size };
  }

  /** Every backup in the bucket, newest first. Objects not named like a backup are left out. */
  async list(): Promise<BackupItem[]> {
    const items: BackupItem[] = [];
    let token: string | undefined;
    do {
      const page = (await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: BACKUP_PREFIX,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      )) as ListPage;
      for (const object of page.Contents ?? []) {
        const filename = (object.Key ?? '').slice(BACKUP_PREFIX.length);
        const parsed = parseBackupFilename(filename);
        if (parsed) items.push({ filename, sizeBytes: object.Size ?? 0, ...parsed });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return items.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.filename.localeCompare(a.filename),
    );
  }

  /** A time-limited link that downloads the backup under its own name. */
  async presignGet(filename: string, expiresInSeconds: number): Promise<{ url: string; expiresAt: Date }> {
    const key = this.keyOf(filename);
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      }),
      { expiresIn: expiresInSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  async delete(filename: string): Promise<void> {
    const key = this.keyOf(filename);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  // Only exact backup names become keys: nothing else in the bucket is reachable from here.
  private keyOf(filename: string): string {
    if (!parseBackupFilename(filename)) throw new Error(`Not a backup name: ${filename}`);
    return `${BACKUP_PREFIX}${filename}`;
  }
}
