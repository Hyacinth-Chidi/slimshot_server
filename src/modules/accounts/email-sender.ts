import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import type { EmailConfig } from '../../config';

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Development only: prints the message (and so the code) in the server log. Refused in production. */
export class LogEmailSender implements EmailSender {
  private readonly logger = new Logger('Email');

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(`[development email] to ${message.to} — ${message.subject}: ${message.text}`);
  }
}

interface MailTransport {
  sendMail(mail: EmailMessage & { from: string }): Promise<unknown>;
}

export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

export function createEmailSender(cfg: EmailConfig): EmailSender {
  if (cfg.sender !== 'smtp') return new LogEmailSender();
  const { host, port, secure, user, password } = cfg.smtp;
  return new SmtpEmailSender(
    createTransport({ host, port, secure, ...(user ? { auth: { user, pass: password } } : {}) }),
    cfg.from,
  );
}
