import { Logger } from '@nestjs/common';
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
  // No Nest `ValidationPipe`: it is built on class-validator, and this codebase
  // validates with Zod so that the SAME schema object runs in the browser and
  // here (docs/09 §4). Two validation systems would mean two sets of rules that
  // can disagree, which is the failure the shared-schema decision exists to
  // prevent. Validation is `ZodBody` at each route.
  app.enableShutdownHooks();

  // `listen(port, hostname)` — NOT an options object. Nest's Fastify adapter
  // takes positional arguments, and an object is coerced to a nonsense port, so
  // the server never binds.
  await app.listen(env.PORT, '0.0.0.0');
  new Logger('bootstrap').log(`API listening on :${env.PORT}/${env.API_PREFIX}`);
}

// A boot failure must be loud and must not leave a half-started process behind.
//
// Written straight to stderr rather than through the Nest logger: `bufferLogs`
// holds messages until the application finishes initialising, so a failure
// DURING initialisation is buffered and then discarded — the process exits
// silently and the only symptom is a port that never opens. That is the single
// worst way for a service to fail.
bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[bootstrap] failed to start: ${message}\n`);
  process.exit(1);
});
