import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { configureHttp } from './app.setup';
import { appConfig, type AppConfig } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<AppConfig>(appConfig.KEY);

  app.enableShutdownHooks();

  // Behind nginx every request comes from the proxy; this makes req.ip the client.
  app.set('trust proxy', config.trustProxy);

  // Empty means allow every origin — acceptable only in development.
  app.enableCors(
    config.corsOrigins.length > 0 ? { origin: config.corsOrigins, credentials: true } : {},
  );

  configureHttp(app);

  await app.listen(config.port);

  new Logger('Bootstrap').log(
    `Application running on port ${config.port} — http://localhost:${config.port}/api/admin/v1`,
  );
}

void bootstrap();
