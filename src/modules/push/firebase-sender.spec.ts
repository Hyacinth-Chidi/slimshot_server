const sendEachForMulticast = jest.fn();
const initializeApp = jest.fn((_options: unknown, name: string) => ({ name }));

jest.mock('firebase-admin/app', () => ({
  cert: (account: unknown) => ({ account }),
  getApps: () => [],
  initializeApp: (options: unknown, name: string) => initializeApp(options, name),
}));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: () => ({ sendEachForMulticast }) }));

import { FirebasePushSender } from './firebase-sender';

const ACCOUNT = { projectId: 'slimshot-app', clientEmail: 'a@slimshot-app.iam.gserviceaccount.com', privateKey: 'KEY' };

describe('FirebasePushSender', () => {
  it('sends the title and message to the tokens, with the message id as data', async () => {
    sendEachForMulticast.mockResolvedValueOnce({ successCount: 2, failureCount: 0, responses: [{ success: true }, { success: true }] });
    const sender = new FirebasePushSender(ACCOUNT);

    expect(await sender.send(['t1', 't2'], { title: 'Hi', body: 'There', messageId: 'm1' })).toEqual({
      sent: 2,
      failed: 0,
      deadTokens: [],
    });
    expect(initializeApp).toHaveBeenCalledWith({ credential: { account: ACCOUNT }, projectId: 'slimshot-app' }, 'slimshot-push');
    expect(sendEachForMulticast).toHaveBeenCalledWith({
      tokens: ['t1', 't2'],
      notification: { title: 'Hi', body: 'There' },
      data: { messageId: 'm1' },
    });
  });

  it('reports tokens Firebase says are gone for good, and not those that failed for a while', async () => {
    sendEachForMulticast.mockResolvedValueOnce({
      successCount: 1,
      failureCount: 3,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/invalid-registration-token' } },
        { success: false, error: { code: 'messaging/server-unavailable' } },
      ],
    });
    const sender = new FirebasePushSender(ACCOUNT);

    expect(await sender.send(['t1', 't2', 't3', 't4'], { title: 'Hi', body: 'x', messageId: 'm1' })).toEqual({
      sent: 1,
      failed: 3,
      deadTokens: ['t2', 't3'],
    });
  });
});
