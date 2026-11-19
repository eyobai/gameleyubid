import { HttpStatus, Injectable } from '@nestjs/common';
import { AccountType, EntryDirection, JournalType } from '@prisma/client';
import type { Journal, LedgerAccount, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AppException, ErrorCode } from '../common/errors';
import { MAX_AMOUNT_MINOR } from '../common/money';
import type { Tx } from '../prisma/prisma.service';

export interface Line {
  accountId: string;
  direction: EntryDirection;
  amountMinor: bigint;
}

export interface PostInput {
  type: JournalType;
  lines: Line[];
  /** Globally unique. Posting again with the same key returns the first journal and moves nothing. */
  idempotencyKey?: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
  createdById?: string;
}

export interface PostResult {
  journal: Journal;
  replayed: boolean;
}

/** Payment clearing is an asset (grows with debits); everything else grows with credits. */
const DEBIT_NORMAL: AccountType[] = [AccountType.PAYMENT_CLEARING];
const ALLOW_NEGATIVE: AccountType[] = [AccountType.PAYMENT_CLEARING, AccountType.OWNER_FUNDS];

export const delta = (type: AccountType, l: Pick<Line, 'direction' | 'amountMinor'>): bigint =>
  (l.direction === EntryDirection.DEBIT) === DEBIT_NORMAL.includes(type) ? l.amountMinor : -l.amountMinor;

export const isDebitNormal = (type: AccountType) => DEBIT_NORMAL.includes(type);

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newReference = () =>
  `TX-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Array.from(randomBytes(10), (b) => ALPHABET[b % 32]).join('')}`;

interface Locked {
  id: string;
  code: string;
  type: AccountType;
  allow_negative: boolean;
  balance_minor: bigint;
}

/**
 * The only code that moves money. A journal and its balanced entries are written in the caller's transaction, with
 * the affected accounts row-locked in id order so concurrent postings queue rather than deadlock or overdraw.
 */
@Injectable()
export class LedgerService {
  async post(tx: Tx, input: PostInput): Promise<PostResult> {
    const amount = validate(input.lines);

    if (input.idempotencyKey) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))::text`;
      const earlier = await tx.journal.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { entries: true },
      });
      if (earlier) {
        if (fingerprint(earlier.type, earlier.entries) !== fingerprint(input.type, input.lines)) {
          throw new AppException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This idempotency key was already used for a different request',
          );
        }
        const { entries: _entries, ...journal } = earlier;
        return { journal, replayed: true };
      }
    }

    const ids = input.lines.map((l) => l.accountId);
    const accounts = await tx.$queryRaw<Locked[]>`
      SELECT id, code, type, allow_negative, balance_minor FROM ledger_accounts
      WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const byId = new Map(accounts.map((a) => [a.id, a]));

    const rows = input.lines.map((line) => {
      const account = byId.get(line.accountId);
      if (!account) throw new Error(`Ledger account ${line.accountId} does not exist`);
      const after = account.balance_minor + delta(account.type, line);
      if (after < 0n && !account.allow_negative) {
        if (account.type === AccountType.PLAYER_WALLET) {
          throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.INSUFFICIENT_FUNDS, 'Not enough balance', {
            requiredMinor: line.amountMinor.toString(),
            availableMinor: account.balance_minor.toString(),
          });
        }
        if (account.type === AccountType.GAME_RESERVE) {
          throw new AppException(HttpStatus.CONFLICT, ErrorCode.RESERVE_TOO_LOW, 'The reserve cannot cover this');
        }
        throw new Error(`Posting would make ${account.code} negative`);
      }
      return { line, account, after };
    });

    const journal = await tx.journal.create({
      data: {
        reference: newReference(),
        type: input.type,
        amountMinor: amount,
        idempotencyKey: input.idempotencyKey,
        description: input.description,
        metadata: input.metadata,
        createdById: input.createdById,
      },
    });
    await tx.ledgerEntry.createMany({
      data: rows.map(({ line, after }) => ({
        journalId: journal.id,
        accountId: line.accountId,
        direction: line.direction,
        amountMinor: line.amountMinor,
        balanceAfterMinor: after,
      })),
    });
    for (const { account, after } of rows) {
      await tx.ledgerAccount.update({ where: { id: account.id }, data: { balanceMinor: after } });
    }
    return { journal, replayed: false };
  }

  /** A platform account (reserve, clearing, owner funds), created on first use. */
  async system(tx: Tx, type: Exclude<AccountType, 'PLAYER_WALLET'>): Promise<LedgerAccount> {
    const existing = await tx.ledgerAccount.findUnique({ where: { code: type } });
    if (existing) return existing;
    await tx.ledgerAccount.createMany({
      data: [{ code: type, type, allowNegative: ALLOW_NEGATIVE.includes(type) }],
      skipDuplicates: true,
    });
    return tx.ledgerAccount.findUniqueOrThrow({ where: { code: type } });
  }

  /** A player's wallet account, created on first use. */
  async wallet(tx: Tx, userId: string): Promise<LedgerAccount> {
    const code = `PLAYER_WALLET:${userId}`;
    const existing = await tx.ledgerAccount.findUnique({ where: { code } });
    if (existing) return existing;
    await tx.ledgerAccount.createMany({
      data: [{ code, type: AccountType.PLAYER_WALLET, userId }],
      skipDuplicates: true,
    });
    return tx.ledgerAccount.findUniqueOrThrow({ where: { code } });
  }

  /**
   * A two-line journal: debit `from`, credit `to`. For wallets and the reserve that moves money from one to the other;
   * for a deposit (from = payment clearing) both grow: the money has arrived and is now owed to the player.
   */
  transfer(
    tx: Tx,
    from: LedgerAccount,
    to: LedgerAccount,
    amountMinor: bigint,
    rest: Omit<PostInput, 'lines'>,
  ): Promise<PostResult> {
    return this.post(tx, {
      ...rest,
      lines: [
        { accountId: from.id, direction: EntryDirection.DEBIT, amountMinor },
        { accountId: to.id, direction: EntryDirection.CREDIT, amountMinor },
      ],
    });
  }
}

function validate(lines: Line[]): bigint {
  if (lines.length < 2) throw new Error('A journal needs at least two lines');
  const seen = new Set<string>();
  let debits = 0n;
  let credits = 0n;
  for (const l of lines) {
    if (typeof l.amountMinor !== 'bigint' || l.amountMinor <= 0n || l.amountMinor > MAX_AMOUNT_MINOR) {
      throw new Error('Ledger amounts must be positive bigint minor units within range');
    }
    if (seen.has(l.accountId)) throw new Error('A journal may use each account once');
    seen.add(l.accountId);
    if (l.direction === EntryDirection.DEBIT) debits += l.amountMinor;
    else credits += l.amountMinor;
  }
  if (debits !== credits) throw new Error(`Unbalanced journal: debits ${debits}, credits ${credits}`);
  return debits;
}

function fingerprint(type: JournalType, lines: Pick<Line, 'accountId' | 'direction' | 'amountMinor'>[]): string {
  return [type, ...lines.map((l) => `${l.accountId}:${l.direction}:${l.amountMinor}`).sort()].join('|');
}
