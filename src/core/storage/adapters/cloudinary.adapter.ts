import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'node:crypto';

import { StorageKind } from '../../../generated/prisma/enums';
import {
  CloudinaryConfig,
  RemoteObject,
  StorageProviderAdapter,
  UploadTicket,
  UploadTicketInput,
} from '../storage-adapter.interface';

interface CloudinaryResource {
  public_id: string;
  bytes: number;
  format: string;
  duration?: number;
  width?: number;
  height?: number;
  secure_url: string;
  resource_type: string;
  etag?: string;
}

/**
 * Cloudinary stores audio under resource_type "video". That is a Cloudinary
 * quirk, not a mistake — audio and video share the same pipeline there.
 */
const RESOURCE_TYPE = 'video';

/** Cloudinary reports resource_type (image/video/raw); map to a sane MIME prefix. */
function mimeFor(resource: CloudinaryResource): string {
  const prefix =
    resource.resource_type === 'image'
      ? 'image'
      : resource.resource_type === 'raw'
        ? 'application'
        : 'audio';
  return `${prefix}/${resource.format}`;
}

export class CloudinaryAdapter implements StorageProviderAdapter {
  readonly kind = StorageKind.cloudinary;

  constructor(
    readonly id: string,
    private readonly config: CloudinaryConfig,
  ) {}

  /**
   * Cloudinary's `config()` mutates one module-level global, so two adapters for
   * different providers clobber each other. Every call therefore carries its own
   * credentials explicitly rather than relying on that singleton.
   */
  private get callConfig(): {
    cloud_name: string;
    api_key: string;
    api_secret: string;
    secure: true;
  } {
    return {
      cloud_name: this.config.cloudName,
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
      secure: true,
    };
  }

  async createUploadTicket(input: UploadTicketInput): Promise<UploadTicket> {
    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `${input.folder}/${randomUUID()}`;

    // Every signed param is pinned, so a holder of this ticket cannot widen
    // the upload beyond the exact object we expect.
    const params: Record<string, string | number> = {
      public_id: publicId,
      timestamp,
      overwrite: 'false',
    };

    const signature = cloudinary.utils.api_sign_request(params, this.config.apiSecret);

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.config.cloudName}/${RESOURCE_TYPE}/upload`,
      storageKey: publicId,
      fields: {
        public_id: publicId,
        timestamp: String(timestamp),
        overwrite: 'false',
        api_key: this.config.apiKey,
        signature,
      },
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    };
  }

  async verifyUpload(storageKey: string): Promise<RemoteObject> {
    let resource: CloudinaryResource;
    try {
      resource = (await cloudinary.api.resource(storageKey, {
        resource_type: RESOURCE_TYPE,
        ...this.callConfig,
      })) as CloudinaryResource;
    } catch (error) {
      const code = (error as { http_code?: number }).http_code;
      if (code === 404) {
        throw new Error(`Uploaded object not found in storage: ${storageKey}`);
      }
      throw error;
    }

    return {
      storageKey: resource.public_id,
      byteSize: resource.bytes,
      format: resource.format,
      mimeType: mimeFor(resource),
      ...(resource.duration !== undefined
        ? { durationMs: Math.round(resource.duration * 1000) }
        : {}),
      ...(resource.width !== undefined ? { width: resource.width } : {}),
      ...(resource.height !== undefined ? { height: resource.height } : {}),
      deliveryUrl: resource.secure_url,
    };
  }

  getDeliveryUrl(storageKey: string): string {
    return cloudinary.url(storageKey, {
      resource_type: RESOURCE_TYPE,
      ...this.callConfig,
    });
  }

  async getSignedUrl(storageKey: string, ttlSeconds: number): Promise<string> {
    return cloudinary.url(storageKey, {
      resource_type: RESOURCE_TYPE,
      sign_url: true,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
      ...this.callConfig,
    });
  }

  async delete(storageKey: string): Promise<void> {
    await cloudinary.uploader.destroy(storageKey, {
      resource_type: RESOURCE_TYPE,
      invalidate: true,
      ...this.callConfig,
    });
  }
}
