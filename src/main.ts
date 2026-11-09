import 'dotenv/config';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ReportingExceptionFilter, initErrorReporting, reportError } from './observability/error-reporting.js';

initErrorReporting('api');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ReportingExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  // Behind the reverse proxy (Caddy) the client address comes from X-Forwarded-For.
  if (process.env.TRUST_PROXY === 'true') app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length > 0) {
    app.enableCors({ origin: origins, credentials: true });
  }

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap().catch((error: unknown) => {
  reportError(error);
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : 'API_START_FAILED\n');
  process.exitCode = 1;
});
