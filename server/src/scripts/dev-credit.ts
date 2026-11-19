/**
 * Development only: credits a player's wallet as if a deposit had been confirmed, so the game can be tried
 * without Chapa. Refuses to run with NODE_ENV=production.
 *   DEV_PHONE=0911234567 DEV_AMOUNT_MINOR=100000 npm run dev:credit
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { normalizePhone } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('dev:credit cannot run in production');
  const phoneNumber = normalizePhone(process.env.DEV_PHONE ?? '');
  const amount = BigInt(process.env.DEV_AMOUNT_MINOR ?? '100000');
  const prisma = new PrismaClient();
  const ledger = new LedgerService();
  const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber } });
  await prisma.$transaction(async (tx) => {
    const clearing = await ledger.system(tx, 'PAYMENT_CLEARING');
    const wallet = await ledger.wallet(tx, user.id);
    await ledger.transfer(tx, clearing, wallet, amount, { type: 'DEPOSIT', idempotencyKey: `dev-credit:${randomUUID()}`, description: 'Development credit' });
  });
  console.log(`Credited ${amount} minor units to ${phoneNumber}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
