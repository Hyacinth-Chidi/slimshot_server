import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { appAuthConfig, authConfig, captionConfig, cryptoConfig, emailConfig, speechConfig } from '../../config';
import { AuditService } from '../../core/audit/audit.service';
import { CacheService, REDIS } from '../../core/cache/cache.service';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { RateLimiter } from '../../core/rate-limit/rate-limiter';
import { StorageRegistry } from '../../core/storage/storage.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SpeechSweeper } from './speech-sweeper';
import { QUEUE_SPEECH } from './speech.constants';
import { SpeechController } from './speech.controller';
import { SpeechModule } from './speech.module';
import { SpeechService } from './speech.service';
import { SpeechWorker } from './speech.worker';

// Stand-ins for the app's global modules: Prisma, audit, Redis, storage and identity.
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: AuditService, useValue: {} },
    { provide: REDIS, useValue: {} },
    { provide: CacheService, useValue: {} },
    { provide: StorageRegistry, useValue: {} },
    { provide: IdentityHashService, useValue: {} },
    { provide: RateLimiter, useValue: {} },
  ],
  exports: [PrismaService, AuditService, REDIS, CacheService, StorageRegistry, IdentityHashService, RateLimiter],
})
class CoreStandIns {}

describe('SpeechModule', () => {
  // A wiring mistake would only show when the API starts in production. Real DI, the queue stood in.
  it('resolves its controller, service, worker and sweeper', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [speechConfig, captionConfig, appAuthConfig, authConfig, cryptoConfig, emailConfig],
        }),
        CoreStandIns,
        SpeechModule,
      ],
    })
      .overrideProvider(getQueueToken(QUEUE_SPEECH))
      .useValue({})
      .compile();

    expect(moduleRef.get(SpeechController)).toBeInstanceOf(SpeechController);
    expect(moduleRef.get(SpeechService)).toBeInstanceOf(SpeechService);
    expect(moduleRef.get(SpeechWorker)).toBeInstanceOf(SpeechWorker);
    expect(moduleRef.get(SpeechSweeper)).toBeInstanceOf(SpeechSweeper);
    await moduleRef.close();
  });
});
