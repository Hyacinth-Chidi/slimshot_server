import { UnprocessableEntityException } from '@nestjs/common';

import { assertCapability, assertProvider } from './provider-params';

describe('provider params', () => {
  it('accepts known values', () => {
    expect(assertProvider('deepgram')).toBe('deepgram');
    expect(assertProvider('elevenlabs')).toBe('elevenlabs');
    expect(assertCapability('speech_to_text')).toBe('speech_to_text');
  });

  it.each([undefined, '', 'openai', 'Deepgram', ['deepgram']])('rejects provider %j with 422', (value) => {
    expect(() => assertProvider(value)).toThrow(UnprocessableEntityException);
  });

  it('names the allowed values', () => {
    expect(() => assertCapability('tts')).toThrow('capability must be one of: speech_to_text.');
  });
});
