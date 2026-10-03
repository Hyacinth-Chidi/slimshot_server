import { generateKeyPairSync, sign } from 'node:crypto';

import { AdmobVerifier, SsvSignatureError } from './admob-verifier';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const CONTENT =
  'ad_network=5450213213286189855&ad_unit=ca-app-pub-1%2F2&custom_data=n%2Babc&reward_amount=5' +
  '&reward_item=credits&timestamp=1759500000000&transaction_id=tx-1&user_id=u1';

function signed(content = CONTENT, keyId = '123'): string {
  const signature = sign('sha256', Buffer.from(content), { key: privateKey, dsaEncoding: 'der' }).toString('base64url');
  return `${content}&signature=${signature}&key_id=${keyId}`;
}

function build() {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ keys: [{ keyId: 123, pem: PEM, base64: '' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const verifier = new AdmobVerifier({
    adUnitIds: [],
    verifierKeysUrl: 'https://www.gstatic.com/admob/reward/verifier-keys.json',
  } as never);
  return { verifier, fetchMock };
}

describe('AdmobVerifier', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts a callback signed by a published key and reads its fields', async () => {
    const { verifier, fetchMock } = build();
    await expect(verifier.verify(signed())).resolves.toEqual({
      adUnit: 'ca-app-pub-1/2',
      customData: 'n+abc',
      userId: 'u1',
      transactionId: 'tx-1',
      rewardAmount: '5',
      timestamp: '1759500000000',
      keyId: '123',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.gstatic.com/admob/reward/verifier-keys.json',
      expect.anything(),
    );
  });

  it('refuses a tampered callback', async () => {
    const { verifier } = build();
    const tampered = signed().replace('reward_amount=5', 'reward_amount=500');
    await expect(verifier.verify(tampered)).rejects.toBeInstanceOf(SsvSignatureError);
  });

  it('refuses a callback without a signature', async () => {
    const { verifier } = build();
    await expect(verifier.verify(CONTENT)).rejects.toBeInstanceOf(SsvSignatureError);
  });

  it('refetches the keys for an unknown key id, at most once a minute, then refuses', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { verifier, fetchMock } = build();
    await verifier.verify(signed());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 61_000);
    await expect(verifier.verify(signed(CONTENT, '999'))).rejects.toBeInstanceOf(SsvSignatureError);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(verifier.verify(signed(CONTENT, '999'))).rejects.toBeInstanceOf(SsvSignatureError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches the keys for 24 hours', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { verifier, fetchMock } = build();
    await verifier.verify(signed());
    await verifier.verify(signed());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 24 * 3_600_000 + 1);
    await verifier.verify(signed());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
