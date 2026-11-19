import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccountStatus, Prisma } from '@prisma/client';
import type { User } from '@prisma/client';
import argon2 from 'argon2';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppException, ErrorCode } from '../common/errors';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; phoneNumber: string; role: string };
}

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 } as const;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Normalizes Ethiopian input such as 0911234567 or +251 91 123 4567 to E.164; only mobile numbers. */
export function normalizePhone(input: string): string {
  const parsed = parsePhoneNumberFromString(input ?? '', 'ET');
  const type = parsed?.getType();
  if (!parsed || !parsed.isValid() || parsed.country !== 'ET' || (type && type !== 'MOBILE')) {
    throw new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.INVALID_PHONE_NUMBER,
      'Enter an Ethiopian mobile number, e.g. 0911234567',
    );
  }
  return parsed.number;
}

@Injectable()
export class AuthService {
  /** A real hash to verify against for unknown numbers, so both answers take the same time. */
  private readonly dummyHash = argon2.hash('not-a-real-password-' + randomUUID(), ARGON);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly ledger: LedgerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async register(phone: string, password: string): Promise<Session> {
    const phoneNumber = normalizePhone(phone);
    const passwordHash = await argon2.hash(password, ARGON);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({ data: { phoneNumber, passwordHash } });
        await this.ledger.wallet(tx, created.id);
        return created;
      });
      return this.startSession(user);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.PHONE_ALREADY_REGISTERED, 'This number already has an account. Sign in instead.');
      }
      throw e;
    }
  }

  async login(phone: string, password: string): Promise<Session> {
    const invalid = () =>
      new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.INVALID_CREDENTIALS, 'Incorrect phone number or password');
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhone(phone);
    } catch {
      await argon2.verify(await this.dummyHash, password);
      throw invalid();
    }
    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });
    const ok = await argon2.verify(user?.passwordHash ?? (await this.dummyHash), password);
    if (!user || !ok) throw invalid();
    if (user.status !== AccountStatus.ACTIVE) {
      throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_BLOCKED, 'This account is blocked');
    }
    return this.startSession(user);
  }

  /**
   * Swaps a refresh token for a new pair. A token can be used once: presenting a used one again means it was
   * copied, so the whole sign-in it belongs to is ended.
   */
  async refresh(refreshToken: string): Promise<Session> {
    const invalid = () =>
      new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.INVALID_REFRESH_TOKEN, 'Sign in again');
    const hash = sha256(refreshToken ?? '');
    const outcome = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM refresh_tokens WHERE token_hash = ${hash} FOR UPDATE`;
      if (!rows.length) return null;
      const token = await tx.refreshToken.findUniqueOrThrow({ where: { id: rows[0].id }, include: { user: true } });
      if (token.rotatedAt || token.revokedAt) {
        await tx.refreshToken.updateMany({ where: { familyId: token.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        return 'reused' as const;
      }
      if (token.expiresAt <= new Date() || token.user.status !== AccountStatus.ACTIVE) return null;
      await tx.refreshToken.update({ where: { id: token.id }, data: { rotatedAt: new Date() } });
      return { user: token.user, familyId: token.familyId };
    });
    if (!outcome || outcome === 'reused') throw invalid();
    return this.startSession(outcome.user, outcome.familyId);
  }

  async logout(refreshToken: string): Promise<void> {
    const token = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken ?? '') } });
    if (token) {
      await this.prisma.refreshToken.updateMany({ where: { familyId: token.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
  }

  private async startSession(user: User, familyId: string = randomUUID()): Promise<Session> {
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + this.config.jwt.refreshTtlDays * 86_400_000),
      },
    });
    const accessToken = await this.jwt.signAsync({ sub: user.id, typ: 'access' });
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.jwt.accessTtlSeconds,
      user: { id: user.id, phoneNumber: user.phoneNumber, role: user.role },
    };
  }
}
