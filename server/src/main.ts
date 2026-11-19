import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { buildAppModule } from './app.module';
import { setupApp } from './app.setup';
import { loadConfig } from './config/config';

(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(buildAppModule(config), { rawBody: true });
  setupApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`Updraft API on :${config.port} (game ${config.game.enabled ? 'on' : 'off'}, payments ${config.payments.provider})`);
}
void bootstrap();
