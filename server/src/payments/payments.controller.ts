import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import type { Request } from 'express';
import { CurrentUser, IdempotencyKey, Public } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { PaymentsService } from './payments.service';

class StartDepositDto {
  @IsString()
  @Matches(/^[1-9]\d{0,14}$/)
  amountMinor: string;
}

@Controller('wallet/deposits')
export class DepositsController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Get('options')
  options() {
    return this.payments.options();
  }

  @Post()
  start(@CurrentUser() user: AuthUser, @Body() dto: StartDepositDto, @IdempotencyKey() key: string) {
    return this.payments.start(user, BigInt(dto.amountMinor), key);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.payments.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(user.id, id);
  }
}

/** Called by Chapa. Neither route trusts what it is told: both only trigger a check with Chapa. */
@Public()
@Controller('payments/chapa')
export class ChapaHooksController {
  constructor(private readonly payments: PaymentsService) {}

  @HttpCode(HttpStatus.OK)
  @Post('webhook')
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, unknown>, @Body() body: unknown) {
    await this.payments.handleWebhook(req.rawBody ?? JSON.stringify(body ?? {}), headers, body);
    return { received: true };
  }

  @Get('callback')
  async callback(@Query() q: Record<string, unknown>) {
    await this.payments.handleCallback(q.trx_ref ?? q.tx_ref);
    return { received: true };
  }
}
