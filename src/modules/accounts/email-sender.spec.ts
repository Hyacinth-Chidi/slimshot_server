import { Logger } from '@nestjs/common';

import { LogEmailSender, SmtpEmailSender } from './email-sender';

describe('email senders', () => {
  it('the log sender prints the message (development only)', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new LogEmailSender().send({ to: 'ann@example.com', subject: 'Code', text: 'Your code is 123456.' });
    expect(String(log.mock.calls[0][0])).toContain('123456');
    log.mockRestore();
  });

  it('the SMTP sender sends from the configured address', async () => {
    const transport = { sendMail: jest.fn(async () => ({ messageId: 'm1' })) };
    await new SmtpEmailSender(transport as never, 'SlimShot <no-reply@example.com>').send({
      to: 'ann@example.com',
      subject: 'Code',
      text: 'Your code is 123456.',
    });
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: 'SlimShot <no-reply@example.com>',
      to: 'ann@example.com',
      subject: 'Code',
      text: 'Your code is 123456.',
    });
  });
});
