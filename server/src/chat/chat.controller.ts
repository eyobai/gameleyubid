import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { BetStatus, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { CurrentUser, Roles } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { AppException, ErrorCode, notFound } from '../common/errors';
import { maskPhone } from '../game/game.service';
import { PrismaService } from '../prisma/prisma.service';
import { chatRefusal } from './chat.rules';

class PostDto {
  @IsString()
  @Length(1, 200)
  text: string;
}

class AfterQuery {
  @IsOptional()
  @IsString()
  after?: string;
}

class MuteDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60 * 24 * 365)
  minutes: number;

  @IsString()
  @Length(3, 300)
  reason: string;
}

const RATE_MS = 3000;

@Controller('chat')
export class ChatController {
  constructor(private readonly prisma: PrismaService) {}

  /** The latest visible messages, oldest first. Pass `after` (an ISO time) to get only newer ones. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: AfterQuery) {
    const after = q.after && !Number.isNaN(Date.parse(q.after)) ? new Date(q.after) : null;
    const rows = await this.prisma.chatMessage.findMany({
      where: { hiddenAt: null, ...(after ? { createdAt: { gt: after } } : {}) },
      include: { user: { select: { phoneNumber: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      items: rows.reverse().map((m) => ({
        id: m.id,
        player: m.user.role === Role.PLAYER ? maskPhone(m.user.phoneNumber) : 'Updraft team',
        staff: m.user.role !== Role.PLAYER,
        mine: m.userId === user.id,
        text: m.text,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  @Post()
  async post(@CurrentUser() user: AuthUser, @Body() dto: PostDto) {
    const text = dto.text.trim().replace(/\s+/g, ' ');
    const refused = chatRefusal(text);
    if (refused) throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.CHAT_REFUSED, refused);
    return this.prisma.$transaction(async (tx) => {
      // One message at a time per player, so the rate check cannot be raced.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chat:${user.id}`}, 0))::text`;
      const me = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (me.chatMutedUntil && me.chatMutedUntil > new Date()) {
        throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.CHAT_MUTED, `You can chat again after ${me.chatMutedUntil.toLocaleString('en-GB')}`);
      }
      if (me.role === Role.PLAYER) {
        const played = await tx.bet.count({ where: { userId: user.id, status: { in: [BetStatus.CASHED_OUT, BetStatus.BUSTED] } } });
        if (!played) throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.CHAT_LOCKED, 'Play a round before chatting');
      }
      const last = await tx.chatMessage.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
      if (last && Date.now() - last.createdAt.getTime() < RATE_MS) {
        throw new AppException(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED, 'Slow down a little');
      }
      if (last && last.text === text && Date.now() - last.createdAt.getTime() < 60_000) {
        throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.CHAT_REFUSED, 'You just sent that');
      }
      const m = await tx.chatMessage.create({ data: { userId: user.id, text } });
      return { id: m.id, createdAt: m.createdAt.toISOString() };
    });
  }
}

/** Moderation. Hidden messages stay on record; mutes and hides are written to the audit log. */
@Controller('admin/chat')
@Roles(Role.ADMIN)
export class AdminChatController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const rows = await this.prisma.chatMessage.findMany({
      include: { user: { select: { phoneNumber: true, chatMutedUntil: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      items: rows.map((m) => ({
        id: m.id,
        userId: m.userId,
        phoneNumber: m.user.phoneNumber,
        mutedUntil: m.user.chatMutedUntil?.toISOString() ?? null,
        text: m.text,
        hidden: m.hiddenAt !== null,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  @Post(':id/hide')
  async hide(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.chatMessage.findUnique({ where: { id } });
      if (!m) throw notFound('Message not found');
      await tx.chatMessage.update({ where: { id }, data: { hiddenAt: new Date(), hiddenBy: actor.id } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'chat.hide', entity: id, details: { text: m.text, userId: m.userId } } });
      return { id, hidden: true };
    });
  }

  @Post('players/:id/mute')
  async mute(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MuteDto) {
    const until = new Date(Date.now() + dto.minutes * 60_000);
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id } });
      if (!u || u.role !== Role.PLAYER) throw notFound('Player not found');
      await tx.user.update({ where: { id }, data: { chatMutedUntil: until } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'chat.mute', entity: id, details: { until: until.toISOString(), reason: dto.reason } } });
      return { id, mutedUntil: until.toISOString() };
    });
  }

  @Post('players/:id/unmute')
  async unmute(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { chatMutedUntil: null } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'chat.unmute', entity: id } });
      return { id, mutedUntil: null };
    });
  }
}
