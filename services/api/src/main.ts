import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module.js';
import { ENV, type Env } from './core/config/env.js';

/**
 * Boot.
 *
 * The environment is parsed inside the module factory, so a missing secret stops
 * the process here rather than surfacing as a 500 on the first request that
 * needed it.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 10 * 1024 * 1024 }),
    { bufferLogs: true },
  );

  const env = app.get<Env>(ENV);

  await app.register(helmet, {
    // The API serves JSON, never HTML, so a restrictive CSP costs nothing here
    // and closes off the class of attacks that rely on a response being rendered.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });

  app.setGlobalPrefix(env.API_PREFIX, { exclude: ['healthz', 'readyz'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.enableShutdownHooks();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  new Logger('bootstrap').log(`API listening on :${env.PORT}/${env.API_PREFIX}`);
}

// A boot failure must be loud and must not leave a half-started process behind.
bootstrap().catch((error: unknown) => {
  new Logger('bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
