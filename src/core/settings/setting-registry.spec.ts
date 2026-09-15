import { defineSetting, validateSetting } from './setting-registry';

describe('setting registry', () => {
  const maxBytes = defineSetting({
    key: 'upload.audio.maxBytes',
    group: 'upload',
    type: 'int',
    default: 52_428_800,
    secret: false,
    min: 1,
    max: 1_073_741_824,
  });

  it('accepts a value inside the declared range', () => {
    expect(validateSetting(maxBytes, 1000)).toBe(1000);
  });

  it('rejects a value below the minimum', () => {
    expect(() => validateSetting(maxBytes, 0)).toThrow(/at least 1/);
  });

  it('rejects a value above the maximum', () => {
    expect(() => validateSetting(maxBytes, 2_000_000_000)).toThrow(/at most/);
  });

  it('rejects the wrong primitive type', () => {
    expect(() => validateSetting(maxBytes, 'big')).toThrow(/expected int/);
  });

  it('rejects a non-integer number for an int setting', () => {
    expect(() => validateSetting(maxBytes, 1.5)).toThrow(/expected int/);
  });

  it('validates each element of a string list', () => {
    const mimes = defineSetting({
      key: 'upload.audio.mimeTypes',
      group: 'upload',
      type: 'string[]',
      default: ['audio/mpeg'],
      secret: false,
    });
    expect(validateSetting(mimes, ['audio/wav'])).toEqual(['audio/wav']);
    expect(() => validateSetting(mimes, [1])).toThrow(/expected string\[\]/);
  });

  it('enforces an enum when one is declared', () => {
    const provider = defineSetting({
      key: 'storage.defaultKind',
      group: 'storage',
      type: 'string',
      default: 'cloudinary',
      secret: false,
      enum: ['cloudinary', 's3'] as const,
    });
    expect(validateSetting(provider, 's3')).toBe('s3');
    expect(() => validateSetting(provider, 'ftp')).toThrow(/must be one of/);
  });
});
