import { ProviderKind } from '../../generated/prisma/enums';
import { ProviderError, providerMessage, scrub } from './provider-error';

describe('providerMessage', () => {
  it.each([
    ['Deepgram', { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' }, 'Invalid credentials.'],
    ['a plain message', { message: 'Too many requests' }, 'Too many requests'],
    ['ElevenLabs detail object', { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 'Invalid API key'],
    ['ElevenLabs detail string', { detail: 'Not found' }, 'Not found'],
    ['ElevenLabs validation list', { detail: [{ loc: ['body', 'file'], msg: 'field required' }] }, 'field required'],
  ])('reads %s', (_label, body, expected) => {
    expect(providerMessage(body, 'fallback')).toBe(expected);
  });

  it('falls back when the body says nothing useful', () => {
    expect(providerMessage(null, 'fallback')).toBe('fallback');
    expect(providerMessage({ unrelated: true }, 'fallback')).toBe('fallback');
  });
});

describe('scrub', () => {
  it('removes every copy of the secret', () => {
    expect(scrub('bad key abc12345 (abc12345)', 'abc12345')).toBe('bad key [redacted] ([redacted])');
  });
});

describe('ProviderError.retryable', () => {
  it.each([
    [500, true],
    [503, true],
    [429, true],
    [400, false],
    [401, false],
    [413, false],
  ])('HTTP %i → %s', (status, retryable) => {
    expect(new ProviderError(ProviderKind.deepgram, status, 'x').retryable).toBe(retryable);
  });
});
