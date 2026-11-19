-- New enum values go in their own migration: PostgreSQL cannot use a value in the transaction that adds it.
ALTER TYPE "BetStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "JournalType" ADD VALUE 'BET_CANCEL';
