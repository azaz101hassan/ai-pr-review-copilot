// MUST be the very first import so process.env is populated before any
// other module (notably GithubSignatureGuard) reads from it at DI
// bootstrap. npm workspace runs apps/api with cwd=apps/api, so this
// resolves to apps/api/.env. See README quickstart.
import 'dotenv/config';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });
  app.enableShutdownHooks();

  // Global validation for class-validator DTOs. `transform: true` runs
  // class-transformer so `@Type(() => Number)` on optional query/body
  // numerics actually coerces strings; `whitelist + forbidNonWhitelisted`
  // means unknown fields are rejected, not silently dropped.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = Number(process.env.PORT) || 3001;
  // R15 (Day-7 plan): bind to loopback so the API is not reachable from
  // the LAN. ngrok http 3001 already targets 127.0.0.1 by default, so
  // the Day-5 webhook smoke loop continues to work unchanged.
  await app.listen(port, '127.0.0.1');

  console.log(`apps/api listening on http://localhost:${port}`);
}

if (require.main === module) {
  bootstrap();
}
