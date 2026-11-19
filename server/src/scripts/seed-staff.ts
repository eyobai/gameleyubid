/**
 * Creates (or promotes) a staff account. Staff cannot play or deposit.
 *   SEED_PHONE=0911... SEED_PASSWORD=... SEED_ROLE=ADMIN npm run seed
 */
import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';
import { normalizePhone } from '../auth/auth.service';

async function main() {
  const phone = process.env.SEED_PHONE ?? '';
  const password = process.env.SEED_PASSWORD ?? '';
  const role = (process.env.SEED_ROLE ?? 'ADMIN') as Role;
  if (!Object.values(Role).includes(role) || role === Role.PLAYER) throw new Error('SEED_ROLE must be ADMIN or FINANCE');
  if (password.length < 12) throw new Error('SEED_PASSWORD must be at least 12 characters');
  const phoneNumber = normalizePhone(phone);
  const prisma = new PrismaClient();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
  const user = await prisma.user.upsert({
    where: { phoneNumber },
    update: { role, passwordHash },
    create: { phoneNumber, passwordHash, role },
  });
  console.log(`${user.phoneNumber} is now ${user.role}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
