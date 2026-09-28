import { UnprocessableEntityException } from '@nestjs/common';

import { AdminProvidersController } from './admin-providers.controller';

const STT = 'speech_to_text' as const;
const user = { sub: 'admin-1', email: 'o@example.com', role: 'owner' } as never;

function build() {
  const list = [{ provider: 'deepgram', capability: STT, configured: true, active: true, updatedAt: null }];
  const credentials = {
    list: jest.fn(async () => list),
    setKey: jest.fn(async () => undefined),
    removeKey: jest.fn(async () => undefined),
    activate: jest.fn(async () => list),
    deactivate: jest.fn(async () => list),
    test: jest.fn(async () => ({ ok: true, message: 'Key works.' })),
  };
  return { ctl: new AdminProvidersController(credentials as never), credentials, list };
}

describe('AdminProvidersController', () => {
  it('lists providers for a capability', async () => {
    const { ctl, credentials, list } = build();
    await expect(ctl.list(STT)).resolves.toEqual({ success: true, data: list });
    expect(credentials.list).toHaveBeenCalledWith(STT);
  });

  it('rejects a missing capability before touching the service', async () => {
    const { ctl, credentials } = build();
    await expect(ctl.list(undefined)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(credentials.list).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider with 422', async () => {
    const { ctl, credentials } = build();
    await expect(ctl.activate('openai', { capability: STT }, user)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(credentials.activate).not.toHaveBeenCalled();
  });

  it('saves a key as the calling admin and never echoes it', async () => {
    const { ctl, credentials } = build();
    const out = await ctl.setKey('deepgram', { capability: STT, apiKey: 'dg-secret-key-1' }, user);

    expect(credentials.setKey).toHaveBeenCalledWith('deepgram', STT, 'dg-secret-key-1', 'admin-1');
    expect(out).toEqual({ success: true, data: { configured: true } });
  });

  it('removes a key', async () => {
    const { ctl, credentials } = build();
    await expect(ctl.removeKey('elevenlabs', STT, user)).resolves.toEqual({
      success: true,
      data: { configured: false },
    });
    expect(credentials.removeKey).toHaveBeenCalledWith('elevenlabs', STT, 'admin-1');
  });

  it('activates, deactivates and tests', async () => {
    const { ctl, credentials, list } = build();
    await expect(ctl.activate('deepgram', { capability: STT }, user)).resolves.toEqual({ success: true, data: list });
    await expect(ctl.deactivate('deepgram', { capability: STT }, user)).resolves.toEqual({ success: true, data: list });
    await expect(ctl.test('deepgram', { capability: STT })).resolves.toEqual({
      success: true,
      data: { ok: true, message: 'Key works.' },
    });
    expect(credentials.test).toHaveBeenCalledWith('deepgram', STT);
  });
});
