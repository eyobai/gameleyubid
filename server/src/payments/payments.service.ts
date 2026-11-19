import { HttpStatus, Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AccountType, DepositStatus, JournalType, Prisma } from '@prisma/client';
import type { Deposit } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { isStaff } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { AppException, ErrorCode, notFound } from '../common/errors';
import { formatMinor } from '../common/money';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { LedgerService } from '../ledger/ledger.service';
import { MONEY_TX, PrismaService } from '../prisma/prisma.service';
import { ChapaClient, ChapaError } from './chapa.client';
import { isTestKey, judgeVerification, minorToDecimal, webhookSignatureValid } from './chapa.rules';

const MAX_UNCONFIRMED = 5;
const REFERENCE = /^UPD-[0-9A-Z]{16}$/;

export interface DepositDto {
  id: string;
  reference: string;
  status: DepositStatus;
  amountMinor: string;
  amount: string;
  currency: string;
  testMode: boolean;
  checkoutUrl: string | null;
  failureReason: string | null;
  createdAt: string;
}

/**
 * Deposits through Chapa. A wallet is credited only after this server has asked Chapa about the payment and the
 * amount, currency, reference and mode all match. What a browser, callback or webhook body says is never trusted.
 */
@Injectable()
export class PaymentsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Payments');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly chapa: ChapaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get enabled(): boolean {
    return this.config.payments.provider === 'chapa';
  }

  private get testMode(): boolean {
    return isTestKey(this.config.payments.chapa.secretKey);
  }

  options() {
    const p = this.config.payments;
    const money = (v: bigint) => formatMinor(v, this.config.currency.minorUnits);
    return {
      enabled: this.enabled,
      testMode: this.enabled && this.testMode,
      currency: this.config.currency.code,
      minAmountMinor: p.minDepositMinor.toString(),
      minAmount: money(p.minDepositMinor),
      maxAmountMinor: p.maxDepositMinor.toString(),
      maxAmount: money(p.maxDepositMinor),
    };
  }

  async start(user: AuthUser, amountMinor: bigint, key: string): Promise<DepositDto> {
    if (!this.enabled) throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.PAYMENTS_UNAVAILABLE, 'Deposits are not available right now');
    if (isStaff(user.role)) throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'Staff accounts cannot deposit');
    const p = this.config.payments;
    if (amountMinor < p.minDepositMinor || amountMinor > p.maxDepositMinor) {
      throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.DEPOSIT_AMOUNT_INVALID, 'Choose an amount within the deposit limits', this.options());
    }

    const deposit = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`deposit:${user.id}`}, 0))::text`;
      const earlier = await tx.deposit.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } } });
      if (earlier) {
        if (earlier.amountMinor !== amountMinor) {
          throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.IDEMPOTENCY_KEY_REUSED, 'This idempotency key was already used for a different deposit');
        }
        return { deposit: earlier, replay: true };
      }
      const open = await tx.deposit.count({
        where: { userId: user.id, status: { in: [DepositStatus.INITIATED, DepositStatus.PENDING] } },
      });
      if (open >= MAX_UNCONFIRMED) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.DEPOSIT_LIMIT_REACHED, 'Finish or wait out your unconfirmed deposits first');
      }
      const reference = `UPD-${Array.from(randomBytes(16), (b) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[b % 32]).join('')}`;
      const created = await tx.deposit.create({
        data: { userId: user.id, idempotencyKey: key, reference, amountMinor, testMode: this.testMode },
      });
      return { deposit: created, replay: false };
    });
    if (deposit.replay) return this.toDto(deposit.deposit);

    const d = deposit.deposit;
    try {
      const { checkoutUrl } = await this.chapa.initialize({
        txRef: d.reference,
        amount: minorToDecimal(d.amountMinor, this.config.currency.minorUnits),
        currency: this.config.currency.code,
        returnUrl: `${this.config.publicUrl}/wallet?deposit=${d.id}`,
        callbackUrl: `${this.config.publicUrl}/api/v1/payments/chapa/callback`,
        title: 'Updraft deposit',
        description: 'Add money to your Updraft wallet',
      });
      const updated = await this.prisma.deposit.update({ where: { id: d.id }, data: { status: DepositStatus.PENDING, checkoutUrl } });
      return this.toDto(updated);
    } catch (e) {
      const reason = e instanceof ChapaError ? e.message : 'Chapa could not be reached';
      await this.prisma.deposit.update({ where: { id: d.id }, data: { status: DepositStatus.FAILED, failureReason: reason.slice(0, 300) } });
      throw new AppException(HttpStatus.BAD_GATEWAY, ErrorCode.PAYMENT_PROVIDER_ERROR, 'The payment could not be opened. Try again.');
    }
  }

  async list(userId: string): Promise<{ items: DepositDto[] }> {
    const rows = await this.prisma.deposit.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { items: rows.map((d) => this.toDto(d)) };
  }

  /** One of my deposits. Asks Chapa while it is unconfirmed, so returning from checkout shows the result. */
  async get(userId: string, id: string): Promise<DepositDto> {
    const d = await this.prisma.deposit.findFirst({ where: { id, userId } });
    if (!d) throw notFound('Deposit not found');
    if (d.status === DepositStatus.PENDING) {
      await this.confirm(d.reference).catch((e) => this.logger.warn(`Check of ${d.reference} failed: ${String(e)}`));
      return this.toDto(await this.prisma.deposit.findUniqueOrThrow({ where: { id } }));
    }
    return this.toDto(d);
  }

  async handleWebhook(raw: string | Buffer, headers: Record<string, unknown>, body: unknown): Promise<void> {
    const secret = this.config.payments.chapa.webhookSecret;
    if (!this.enabled || !secret || !webhookSignatureValid(secret, raw, headers)) {
      throw new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Invalid signature');
    }
    const eventKey = createHash('sha256').update(raw).digest('hex');
    try {
      await this.prisma.providerEvent.create({ data: { eventKey, payload: (body ?? {}) as Prisma.InputJsonValue } });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
    const ref = (body as { tx_ref?: unknown; trx_ref?: unknown } | null)?.tx_ref ?? (body as { trx_ref?: unknown } | null)?.trx_ref;
    await this.handleCallback(ref);
  }

  async handleCallback(ref: unknown): Promise<void> {
    if (!this.enabled || typeof ref !== 'string' || !REFERENCE.test(ref)) return;
    try {
      await this.confirm(ref);
    } catch (e) {
      if (e instanceof ChapaError && !e.refused) {
        throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_BUSY, 'Chapa could not be asked; send the event again');
      }
      throw e;
    }
  }

  /** The one path to a credit: ask Chapa, judge the answer, credit once under the deposit's row lock. */
  async confirm(reference: string): Promise<void> {
    const d = await this.prisma.deposit.findUnique({ where: { reference } });
    if (!d || d.status === DepositStatus.SUCCEEDED) return;
    const answer = await this.chapa.verify(reference);
    const outcome = judgeVerification(answer, {
      txRef: reference,
      amountMinor: d.amountMinor,
      currency: this.config.currency.code,
      minorUnits: this.config.currency.minorUnits,
      testMode: d.testMode,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM deposits WHERE id = ${d.id}::uuid FOR UPDATE`;
      const current = await tx.deposit.findUniqueOrThrow({ where: { id: d.id } });
      if (current.status === DepositStatus.SUCCEEDED) return;
      const checked = new Date();
      if (outcome.state === 'paid') {
        const clearing = await this.ledger.system(tx, AccountType.PAYMENT_CLEARING);
        const wallet = await this.ledger.wallet(tx, current.userId);
        const posted = await this.ledger.transfer(tx, clearing, wallet, current.amountMinor, {
          type: JournalType.DEPOSIT,
          idempotencyKey: `deposit:chapa:${reference}`,
          description: 'Deposit through Chapa',
          metadata: { reference, providerReference: outcome.reference },
        });
        await tx.deposit.update({
          where: { id: d.id },
          data: { status: DepositStatus.SUCCEEDED, journalId: posted.journal.id, providerReference: outcome.reference, lastCheckedAt: checked },
        });
      } else if (outcome.state === 'failed') {
        await tx.deposit.update({ where: { id: d.id }, data: { status: DepositStatus.FAILED, failureReason: outcome.reason, lastCheckedAt: checked } });
      } else if (outcome.state === 'mismatch') {
        this.logger.warn(`Deposit ${reference} needs review: ${outcome.reason}`);
        await tx.deposit.update({ where: { id: d.id }, data: { reviewReason: outcome.reason, lastCheckedAt: checked } });
      } else {
        await tx.deposit.update({ where: { id: d.id }, data: { lastCheckedAt: checked } });
      }
    }, MONEY_TX);
  }

  /** Background job: re-checks unconfirmed deposits and closes the ones that never got paid. */
  async sweep(): Promise<void> {
    const expiry = new Date(Date.now() - this.config.payments.expiryMinutes * 60_000);
    const pending = await this.prisma.deposit.findMany({
      where: { status: DepositStatus.PENDING, reviewReason: null },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: 50,
    });
    for (const d of pending) {
      await this.confirm(d.reference).catch((e) => this.logger.warn(`Check of ${d.reference} failed: ${String(e)}`));
      if (d.createdAt < expiry) {
        await this.prisma.deposit.updateMany({ where: { id: d.id, status: DepositStatus.PENDING }, data: { status: DepositStatus.EXPIRED } });
      }
    }
  }

  onApplicationBootstrap() {
    const every = this.config.payments.sweepIntervalSeconds;
    if (!this.enabled || every <= 0) return;
    this.timer = setInterval(() => void this.sweep().catch((e) => this.logger.error(String(e))), every * 1000);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  toDto(d: Deposit): DepositDto {
    return {
      id: d.id,
      reference: d.reference,
      status: d.status,
      amountMinor: d.amountMinor.toString(),
      amount: formatMinor(d.amountMinor, this.config.currency.minorUnits),
      currency: this.config.currency.code,
      testMode: d.testMode,
      checkoutUrl: d.status === DepositStatus.PENDING ? d.checkoutUrl : null,
      failureReason: d.failureReason,
      createdAt: d.createdAt.toISOString(),
    };
  }
}
