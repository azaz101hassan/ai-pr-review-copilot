// MUST be the very first import so process.env is populated before any
// other module (notably GithubSignatureGuard) reads from it at DI
// bootstrap. npm workspace runs apps/api with cwd=apps/api, so this
// resolves to apps/api/.env. See README quickstart.
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || 3001;
  await app.listen(port);

  console.log(`apps/api listening on http://localhost:${port}`);
}

bootstrap();
