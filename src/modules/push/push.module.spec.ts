import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { pushConfig } from '../../config';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PUSH_SENDER, QUEUE_PUSH } from './push.constants';
import { PushModule } from './push.module';
import { PushService } from './push.service';
import { PushWorker } from './push.worker';

// Stand-ins for the app's global Prisma and audit modules.
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: AuditService, useValue: {} },
  ],
  exports: [PrismaService, AuditService],
})
class CoreStandIns {}

describe('PushModule', () => {
  // A wiring mistake would only show when the API starts in production. Real DI, the queue stood in.
  it('resolves its service and worker, and sends nothing until Firebase is set up', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [pushConfig] }), CoreStandIns, PushModule],
    })
      .overrideProvider(getQueueToken(QUEUE_PUSH))
      .useValue({})
      .compile();

    expect(moduleRef.get(PushService)).toBeInstanceOf(PushService);
    expect(moduleRef.get(PushWorker)).toBeInstanceOf(PushWorker);
    expect(moduleRef.get(PUSH_SENDER)).toBeNull();
    await moduleRef.close();
  });
});
