import { INestApplication, ValidationPipe } from '@nestjs/common';

import { AllExceptionsFilter } from './core/errors/http-exception.filter';

/** The request pipeline every entry point shares: the server itself and HTTP specs. */
export function configureHttp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}
