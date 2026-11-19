import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppConfig } from './config/config';

/** Shared by main.ts and the integration tests. */
export function setupApp(app: INestApplication, config: AppConfig): void {
  const server = app as NestExpressApplication;
  if (config.trustProxy) server.set('trust proxy', 1);
  server.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  server.enableCors({ origin: config.corsOrigins, credentials: false });
  server.setGlobalPrefix('api/v1', { exclude: ['health'] });
  server.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  // One address for the whole product: the built player site is served next to the API.
  if (config.webDistDir) {
    const dir = resolve(config.webDistDir);
    if (existsSync(join(dir, 'index.html'))) {
      server.use(express.static(dir, { index: false, maxAge: '1h' }));
      server.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path === '/health') return next();
        res.sendFile(join(dir, 'index.html'));
      });
    }
  }
}
