const mockApiSignRequest = jest.fn().mockReturnValue('signed-abc');
const mockResource = jest.fn();
const mockDestroy = jest.fn();
const mockUrl = jest.fn().mockReturnValue('https://res.cloudinary.com/demo/x.mp3');

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    url: (...args: unknown[]) => mockUrl(...args),
    utils: { api_sign_request: (...a: unknown[]) => mockApiSignRequest(...a) },
    api: { resource: (...a: unknown[]) => mockResource(...a) },
    uploader: { destroy: (...a: unknown[]) => mockDestroy(...a) },
  },
}));

import { CloudinaryAdapter } from './cloudinary.adapter';

const CONFIG = {
  cloudName: 'demo',
  apiKey: 'key-1',
  apiSecret: 'secret-1',
  folder: 'slimshot/audio',
};

describe('CloudinaryAdapter', () => {
  beforeEach(() => jest.clearAllMocks());

  const adapter = new CloudinaryAdapter('prov-1', CONFIG);

  it('issues a ticket whose storage key is scoped to the configured folder', async () => {
    const ticket = await adapter.createUploadTicket({
      folder: 'slimshot/audio',
      filename: 'Rise Up.mp3',
      mimeType: 'audio/mpeg',
      ttlSeconds: 900,
    });

    expect(ticket.storageKey.startsWith('slimshot/audio/')).toBe(true);
    expect(ticket.uploadUrl).toContain('/demo/');
    expect(ticket.fields.signature).toBe('signed-abc');
    expect(ticket.fields.api_key).toBe('key-1');
  });

  it('never leaks the api secret into the ticket handed to the browser', async () => {
    const ticket = await adapter.createUploadTicket({
      folder: 'slimshot/audio',
      filename: 'a.mp3',
      mimeType: 'audio/mpeg',
      ttlSeconds: 900,
    });
    expect(JSON.stringify(ticket)).not.toContain('secret-1');
  });

  it('sets an expiry derived from the requested ttl', async () => {
    const before = Date.now();
    const ticket = await adapter.createUploadTicket({
      folder: 'slimshot/audio',
      filename: 'a.mp3',
      mimeType: 'audio/mpeg',
      ttlSeconds: 600,
    });
    expect(ticket.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000 - 2_000);
    expect(ticket.expiresAt.getTime()).toBeLessThanOrEqual(before + 600_000 + 2_000);
  });

  it('reads authoritative metadata from the provider, converting seconds to ms', async () => {
    mockResource.mockResolvedValue({
      public_id: 'slimshot/audio/rise',
      bytes: 812_340,
      format: 'mp3',
      duration: 145.2,
      secure_url: 'https://res.cloudinary.com/demo/rise.mp3',
      resource_type: 'video',
    });

    const obj = await adapter.verifyUpload('slimshot/audio/rise');

    expect(obj.byteSize).toBe(812_340);
    expect(obj.durationMs).toBe(145_200);
    expect(obj.format).toBe('mp3');
    expect(obj.deliveryUrl).toBe('https://res.cloudinary.com/demo/rise.mp3');
  });

  it('throws when the object does not exist, so finalize cannot invent a row', async () => {
    mockResource.mockRejectedValue({ http_code: 404, message: 'Not Found' });
    await expect(adapter.verifyUpload('slimshot/audio/ghost')).rejects.toThrow(
      /not found/i,
    );
  });

  it('omits durationMs for an object that has no duration', async () => {
    mockResource.mockResolvedValue({
      public_id: 'slimshot/img/cover',
      bytes: 4_210,
      format: 'jpg',
      secure_url: 'https://res.cloudinary.com/demo/cover.jpg',
      resource_type: 'image',
      width: 800,
      height: 800,
    });

    const obj = await adapter.verifyUpload('slimshot/img/cover');
    expect(obj.durationMs).toBeUndefined();
    expect(obj.width).toBe(800);
    // Derived from the provider's own resource_type, not assumed to be audio.
    expect(obj.mimeType).toBe('image/jpg');
  });

  it('deletes through the uploader', async () => {
    mockDestroy.mockResolvedValue({ result: 'ok' });
    await adapter.delete('slimshot/audio/rise');
    expect(mockDestroy).toHaveBeenCalledWith('slimshot/audio/rise', {
      resource_type: 'video',
      invalidate: true,
      cloud_name: 'demo',
      api_key: 'key-1',
      api_secret: 'secret-1',
      secure: true,
    });
  });

  it('does not leak another adapter credentials after a second adapter is built', () => {
    // Cloudinary's config() mutates one module-level global; the fix threads each
    // adapter's own credentials through every call instead of relying on it. We assert
    // directly on what the (mocked) SDK was called with, since that is exactly the
    // production code path that used to omit credentials and rely on the singleton —
    // if callConfig were dropped again, this call would carry no cloud_name at all and
    // the assertion below would fail.
    const a = new CloudinaryAdapter('prov-A', {
      cloudName: 'cloud-AAA',
      apiKey: 'key-AAA',
      apiSecret: 'secret-AAA',
      folder: 'a/audio',
    });
    // Constructing B must not hijack A.
    new CloudinaryAdapter('prov-B', {
      cloudName: 'cloud-BBB',
      apiKey: 'key-BBB',
      apiSecret: 'secret-BBB',
      folder: 'b/audio',
    });

    a.getDeliveryUrl('a/audio/track');

    expect(mockUrl).toHaveBeenCalledWith('a/audio/track', {
      resource_type: 'video',
      cloud_name: 'cloud-AAA',
      api_key: 'key-AAA',
      api_secret: 'secret-AAA',
      secure: true,
    });
  });
});
