import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { appConfig, type AppConfig } from './config';
import { AllExceptionsFilter } from './core/errors/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get<AppConfig>(appConfig.KEY);

  app.enableShutdownHooks();

  // Empty means allow every origin — acceptable only in development.
  app.enableCors(
    config.corsOrigins.length > 0 ? { origin: config.corsOrigins, credentials: true } : {},
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.listen(config.port);

  new Logger('Bootstrap').log(
    `Application running on port ${config.port} — http://localhost:${config.port}/api/admin/v1`,
  );
}

void bootstrap();
