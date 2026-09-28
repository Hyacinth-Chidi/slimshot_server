import { ErrorCode } from './error-codes';

describe('ErrorCode', () => {
  it('exposes stable string codes for the documented failure modes', () => {
    expect(ErrorCode.VALIDATION_FAILED).toBe('VALIDATION_FAILED');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.CONFLICT).toBe('CONFLICT');
    expect(ErrorCode.UNAUTHENTICATED).toBe('UNAUTHENTICATED');
    expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCode.INTERNAL).toBe('INTERNAL');
    expect(ErrorCode.CAPTIONS_UNAVAILABLE).toBe('CAPTIONS_UNAVAILABLE');
    expect(ErrorCode.PROVIDER_FAILED).toBe('PROVIDER_FAILED');
    expect(ErrorCode.PAYLOAD_TOO_LARGE).toBe('PAYLOAD_TOO_LARGE');
    expect(ErrorCode.UNSUPPORTED_MEDIA).toBe('UNSUPPORTED_MEDIA');
  });

  it('has no duplicate values', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });
});
