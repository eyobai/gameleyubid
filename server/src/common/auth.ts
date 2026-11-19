import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AccountStatus, Role } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCode } from './errors';

export interface AuthUser {
  id: string;
  phoneNumber: string;
  role: Role;
}

const PUBLIC = 'isPublic';
const ROLES = 'roles';

/** Route needs no sign-in. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Route needs one of these roles. ADMIN passes every role check. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
});

/** The `Idempotency-Key` header, required on every request that moves money. */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest<Request>().header('idempotency-key')?.trim();
  if (!value || !/^[A-Za-z0-9_.:-]{8,100}$/.test(value)) {
    throw new AppException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      'Send an Idempotency-Key header of 8 to 100 letters, digits or - _ . :',
    );
  }
  return value;
});

export const isStaff = (role: Role) => role !== Role.PLAYER;

/**
 * Default deny: every route needs a valid access token unless marked @Public(). The user is read again on every
 * request, so blocking an account or changing its role takes effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const unauthorized = () =>
      new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED, 'Sign in to continue');
    if (!token) throw unauthorized();

    let sub: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; typ: string }>(token);
      if (payload.typ !== 'access') throw new Error('not an access token');
      sub = payload.sub;
    } catch {
      throw unauthorized();
    }
    const user = await this.prisma.user.findUnique({ where: { id: sub } });
    if (!user) throw unauthorized();
    if (user.status !== AccountStatus.ACTIVE) {
      throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_BLOCKED, 'This account is blocked');
    }
    req.user = { id: user.id, phoneNumber: user.phoneNumber, role: user.role };

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles?.length && user.role !== Role.ADMIN && !roles.includes(user.role)) {
      throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'You do not have access to this');
    }
    return true;
  }
}
