import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminController } from './admin/admin.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './common/auth';
import { AllExceptionsFilter } from './common/exception.filter';
import { APP_CONFIG, loadConfig } from './config/config';
import type { AppConfig } from './config/config';
import { GameController, RoundEngine } from './game/game.controller';
import { GameService } from './game/game.service';
import { HealthController } from './health.controller';
import { LedgerService } from './ledger/ledger.service';
import { ChapaClient } from './payments/chapa.client';
import { ChapaHooksController, DepositsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { PrismaModule } from './prisma/prisma.service';
import { WalletController } from './wallet/wallet.controller';

export function buildAppModule(config: AppConfig = loadConfig()) {
  @Module({
    imports: [
      PrismaModule,
      ThrottlerModule.forRoot([
        { name: 'default', ttl: 60_000, limit: config.throttle.limit },
        // Stricter limit per IP on sign-in, registration and token refresh, against password guessing.
        {
          name: 'auth',
          ttl: 60_000,
          limit: config.throttle.authLimit,
          skipIf: (ctx) => !/\/auth\/(login|register|refresh)$/.test(ctx.switchToHttp().getRequest<{ path: string }>().path),
        },
      ]),
      JwtModule.register({
        secret: config.jwt.accessSecret,
        signOptions: { expiresIn: config.jwt.accessTtlSeconds, issuer: config.jwt.issuer, algorithm: 'HS256' },
        verifyOptions: { issuer: config.jwt.issuer, algorithms: ['HS256'] },
      }),
    ],
    controllers: [
      HealthController,
      AuthController,
      WalletController,
      DepositsController,
      ChapaHooksController,
      GameController,
      AdminController,
    ],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      AuthService,
      LedgerService,
      GameService,
      RoundEngine,
      ChapaClient,
      PaymentsService,
    ],
  })
  class AppModule {}
  return AppModule;
}
