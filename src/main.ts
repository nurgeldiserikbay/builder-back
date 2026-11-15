import 'dotenv/config';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ReportingExceptionFilter, initErrorReporting, reportError } from './observability/error-reporting.js';
import { LocaleMiddleware, LocalizeInterceptor } from './i18n/locale.middleware.js';
import { allowedOrigins, originRefusal } from './security/origin-check.js';

initErrorReporting('api');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.setGlobalPrefix('api/v1');
  // Language of the request (Accept-Language) for platform texts; project content is never translated.
  const locale = new LocaleMiddleware();
  app.use(locale.use.bind(locale));
  app.useGlobalInterceptors(new LocalizeInterceptor());
  app.useGlobalFilters(new ReportingExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  // Behind the reverse proxy (Caddy) the client address comes from X-Forwarded-For.
  if (process.env.TRUST_PROXY === 'true') app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // Cross-site request forgery guard: state-changing calls only from the app's own origins (see origin-check.ts).
  const trusted = allowedOrigins();
  app.use((request: { method: string; originalUrl: string; headers: Record<string, string | string[] | undefined>; hostname?: string; protocol?: string; get(name: string): string | undefined }, response: { status(code: number): { json(body: unknown): void } }, next: () => void) => {
    // Behind the trusted proxy the host the browser used is in X-Forwarded-Host (Render rewrites Host).
    const forwarded = process.env.TRUST_PROXY === 'true' ? request.get('x-forwarded-host')?.split(',')[0]?.trim() : undefined;
    const refusal = originRefusal({ method: request.method, path: request.originalUrl, headers: request.headers, host: forwarded || request.get('host'), protocol: request.protocol }, trusted);
    if (!refusal) return next();
    response.status(403).json({ message: refusal, error: 'Forbidden', statusCode: 403 });
  });
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
    app.enableCors({ origin: origins, credentials: true, exposedHeaders: ['Content-Disposition'] });
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
