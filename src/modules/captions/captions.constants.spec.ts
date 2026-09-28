import { CAPTION_JOB_ID, captionJobId, decodeFailure, encodeFailure } from './captions.constants';

describe('captionJobId', () => {
  it('is stable for one device and key, and matches the public id shape', () => {
    const id = captionJobId('dev-1', 'key-12345678');
    expect(id).toBe(captionJobId('dev-1', 'key-12345678'));
    expect(id).toMatch(CAPTION_JOB_ID);
  });

  it('differs across devices sharing a key', () => {
    expect(captionJobId('dev-1', 'key-12345678')).not.toBe(captionJobId('dev-2', 'key-12345678'));
  });
});

describe('failure encoding', () => {
  it('round-trips a code and message through BullMQ\'s failedReason', () => {
    expect(decodeFailure(encodeFailure('PROVIDER_FAILED' as never, 'Corrupt audio: bad header'))).toEqual({
      code: 'PROVIDER_FAILED',
      message: 'Corrupt audio: bad header',
    });
    expect(decodeFailure(encodeFailure('CAPTIONS_UNAVAILABLE' as never, 'off'))).toEqual({
      code: 'CAPTIONS_UNAVAILABLE',
      message: 'off',
    });
  });

  it('never leaks an unexpected failure reason to the app', () => {
    expect(decodeFailure('TypeError: cannot read x of undefined')).toEqual({
      code: 'PROVIDER_FAILED',
      message: 'The caption provider could not process this audio.',
    });
    expect(decodeFailure(undefined).code).toBe('PROVIDER_FAILED');
  });
});
