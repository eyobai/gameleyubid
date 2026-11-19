import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildAppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { loadConfig } from '../src/config/config';
import type { AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { GameService } from '../src/game/game.service';

(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://updraft@localhost:5433/updraft_test';
if (!/test/.test(new URL(TEST_DB).pathname)) throw new Error('Refusing to run against a database without "test" in its name');

let migrated = false;

export interface TestApp {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  prisma: PrismaService;
  game: GameService;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function createApp(env: Record<string, string> = {}): Promise<TestApp> {
  if (!migrated) {
    // Fresh schema in the throwaway test database, then the real migrations.
    const { PrismaClient } = await import('@prisma/client');
    const admin = new PrismaClient({ datasources: { db: { url: TEST_DB } } });
    await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await admin.$executeRawUnsafe('CREATE SCHEMA public');
    await admin.$disconnect();
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: TEST_DB }, stdio: 'ignore' });
    migrated = true;
  }
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    JWT_ACCESS_SECRET: 'test-access-secret-that-is-long-enough-1234',
    GAME_ENABLED: 'true',
    GAME_TICK_MS: '0',
    GAME_CHAIN_LENGTH: '1000',
    THROTTLE_LIMIT: '100000',
    AUTH_THROTTLE_LIMIT: '100000',
    ...env,
  });
  process.env.DATABASE_URL = TEST_DB;
  const moduleRef = await Test.createTestingModule({ imports: [buildAppModule(config)] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  setupApp(app, config);
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    http: () => request(app.getHttpServer()),
    prisma,
    game: app.get(GameService),
    config,
    close: () => app.close(),
  };
}

/** Empties every table except the single game_state row. */
export async function resetDb(prisma: PrismaService): Promise<void> {
  // Append-only triggers would refuse DELETE; TRUNCATE does not fire them.
  await prisma.$executeRawUnsafe(
    'TRUNCATE audit_logs, provider_events, deposits, chat_messages, bets, rounds, seed_chains, ledger_entries, journals, ledger_accounts, refresh_tokens, users CASCADE',
  );
}

let phoneCounter = 0;
export const newPhone = () => `09${String(10000000 + ((Date.now() % 1000) * 10000 + phoneCounter++) % 89999999).padStart(8, '0')}`;

export async function player(t: TestApp): Promise<{ id: string; token: string }> {
  const res = await t.http().post('/api/v1/auth/register').send({ phoneNumber: newPhone(), password: 'secret123' }).expect(201);
  return { id: res.body.user.id, token: res.body.accessToken };
}

export async function staff(t: TestApp, role: 'FINANCE' | 'ADMIN'): Promise<{ id: string; token: string }> {
  const p = await player(t);
  await t.prisma.user.update({ where: { id: p.id }, data: { role } });
  return p;
}

/** Credits a player's wallet the way a confirmed deposit would. */
export async function credit(t: TestApp, userId: string, amountMinor: bigint): Promise<void> {
  const { LedgerService } = await import('../src/ledger/ledger.service');
  const ledger = t.app.get(LedgerService);
  await t.prisma.$transaction(async (tx) => {
    const clearing = await ledger.system(tx, 'PAYMENT_CLEARING');
    const wallet = await ledger.wallet(tx, userId);
    await ledger.transfer(tx, clearing, wallet, amountMinor, { type: 'DEPOSIT', idempotencyKey: `test:${randomUUID()}` });
  });
}

export async function fundReserve(t: TestApp, financeToken: string, amountMinor: bigint) {
  return t
    .http()
    .post('/api/v1/admin/reserve/fund')
    .set('Authorization', `Bearer ${financeToken}`)
    .set('Idempotency-Key', `fund-${randomUUID()}`)
    .send({ amountMinor: amountMinor.toString(), reason: 'Opening bankroll' })
    .expect(201);
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
export const key = () => `k-${randomUUID()}`;

export async function balance(t: TestApp, token: string): Promise<bigint> {
  const res = await t.http().get('/api/v1/wallet').set(auth(token)).expect(200);
  return BigInt(res.body.balanceMinor);
}

export async function reconcile(t: TestApp, financeToken: string) {
  const res = await t.http().get('/api/v1/admin/ledger/reconciliation').set(auth(financeToken)).expect(200);
  return res.body;
}
