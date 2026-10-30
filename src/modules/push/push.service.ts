import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { AuditService } from '../../core/audit/audit.service';
import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { AccountStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { DevicesService } from '../devices/devices.service';
import { JOB_SEND, PUSH_BATCH, PUSH_SENDER, QUEUE_PUSH, type PushJob, type PushSender } from './push.constants';

export interface PushMessageView {
  id: string;
  title: string;
  body: string;
  audience: string;
  userId: string | null;
  status: string;
  targetCount: number;
  sentCount: number;
  failedCount: number;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface PushOverview {
  configured: boolean;
  /** Installs with notifications on. */
  devices: number;
  messages: PushMessageView[];
}

const ERROR_KEPT = 500;

const withToken = (userId: string | null) => ({ pushToken: { not: null }, ...(userId ? { userId } : {}) });

/**
 * Push notifications through Firebase Cloud Messaging. The app gives each
 * install's token; the owner sends a message to every install or to one user's,
 * queued and sent in batches, with dead tokens dropped as Firebase reports them.
 */
@Injectable()
export class PushService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_PUSH) private readonly queue: Queue<PushJob>,
    @Inject(PUSH_SENDER) private readonly sender: PushSender | null,
    private readonly devices: DevicesService,
  ) {}

  /** The app: this install's token, or null when the user turns notifications off. */
  async setToken(deviceToken: string, token: string | null): Promise<{ registered: boolean }> {
    const device = deviceToken ? await this.devices.authenticate(deviceToken) : null;
    if (!device) {
      throw appError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.DEVICE_NOT_REGISTERED,
        'Register this install first (POST /devices), then send its push token.',
      );
    }
    if (token === null) {
      await this.prisma.device.update({ where: { id: device.id }, data: { pushToken: null, pushTokenAt: null } });
      return { registered: false };
    }
    // A token belongs to one install: one moving to this install leaves any other.
    await this.prisma.$transaction([
      this.prisma.device.updateMany({
        where: { pushToken: token, id: { not: device.id } },
        data: { pushToken: null, pushTokenAt: null },
      }),
      this.prisma.device.update({ where: { id: device.id }, data: { pushToken: token, pushTokenAt: new Date() } }),
    ]);
    return { registered: true };
  }

  async overview(): Promise<PushOverview> {
    const [devices, messages] = await Promise.all([
      this.prisma.device.count({ where: withToken(null) }),
      this.prisma.pushMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return { configured: this.sender !== null, devices, messages };
  }

  /** Queues a message to every install, or to one user's (found by id, email or username). */
  async send(input: { title: string; body: string; user?: string }, admin: { id: string }): Promise<{ id: string }> {
    if (!this.sender) {
      throw appError(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.PUSH_NOT_CONFIGURED, 'Push notifications are not set up on this server.');
    }
    const userId = input.user ? await this.findUser(input.user.trim()) : null;
    const targetCount = await this.prisma.device.count({ where: withToken(userId) });
    if (targetCount === 0) {
      throw appError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.PUSH_NO_RECIPIENTS,
        userId ? 'That user has no install with notifications turned on.' : 'No install has notifications turned on yet.',
      );
    }
    const message = await this.prisma.pushMessage.create({
      data: { title: input.title, body: input.body, audience: userId ? 'user' : 'all', userId, targetCount, sentById: admin.id },
    });
    await this.queue.add(JOB_SEND, { messageId: message.id }, { removeOnComplete: true, removeOnFail: true });
    await this.audit.record({
      actorId: admin.id,
      actorType: 'admin',
      action: 'push.sent',
      entityType: 'PushMessage',
      entityId: message.id,
      after: { title: input.title, audience: message.audience, userId, targetCount },
    });
    return { id: message.id };
  }

  /** The worker: sends a queued message in batches, then records how it went. */
  async deliver(messageId: string): Promise<void> {
    const message = await this.prisma.pushMessage.findUnique({ where: { id: messageId } });
    if (!message || message.status !== 'sending') return;
    let sentCount = 0;
    let failedCount = 0;
    try {
      if (!this.sender) throw new Error('Push notifications are not set up on this server.');
      const payload = { title: message.title, body: message.body, messageId: message.id };
      let after: string | undefined;
      for (;;) {
        const batch = await this.prisma.device.findMany({
          where: { ...withToken(message.userId), ...(after ? { id: { gt: after } } : {}) },
          orderBy: { id: 'asc' },
          take: PUSH_BATCH,
          select: { id: true, pushToken: true },
        });
        if (batch.length === 0) break;
        after = batch[batch.length - 1].id;
        const tokens = batch.map((d) => d.pushToken).filter((t): t is string => t !== null);
        const result = await this.sender.send(tokens, payload);
        sentCount += result.sent;
        failedCount += result.failed;
        if (result.deadTokens.length > 0) {
          await this.prisma.device.updateMany({
            where: { pushToken: { in: result.deadTokens } },
            data: { pushToken: null, pushTokenAt: null },
          });
        }
        if (batch.length < PUSH_BATCH) break;
      }
      await this.prisma.pushMessage.update({
        where: { id: message.id },
        data: { status: 'sent', sentCount, failedCount, finishedAt: new Date() },
      });
    } catch (err) {
      await this.prisma.pushMessage.update({
        where: { id: message.id },
        data: {
          status: 'failed',
          sentCount,
          failedCount,
          error: (err instanceof Error ? err.message : String(err)).slice(0, ERROR_KEPT),
          finishedAt: new Date(),
        },
      });
      throw err;
    }
  }

  private async findUser(who: string): Promise<string> {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ id: who }, { email: who.toLowerCase() }, { username: who }],
        accountStatus: { not: AccountStatus.deleted },
      },
      select: { id: true },
    });
    if (!user) throw appError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'No user matches that id, email or username.');
    return user.id;
  }
}
