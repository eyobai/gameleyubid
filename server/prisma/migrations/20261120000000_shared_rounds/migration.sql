-- Shared rounds replace per-player flights. Settled flights stay in the ledger (their journals are kept); only
-- the flight rows go. Refuse if a flight is still in the air, so nobody's bet is lost.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM flights WHERE status = 'OPEN') THEN
    RAISE EXCEPTION 'A flight is still open. Let it settle (start the old server once) before migrating.';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('BETTING', 'FLYING', 'ENDED');

-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('OPEN', 'CASHED_OUT', 'BUSTED');

-- DropForeignKey
ALTER TABLE "flights" DROP CONSTRAINT "flights_seed_pair_id_fkey";

-- DropForeignKey
ALTER TABLE "flights" DROP CONSTRAINT "flights_user_id_fkey";

-- DropForeignKey
ALTER TABLE "seed_pairs" DROP CONSTRAINT "seed_pairs_user_id_fkey";

-- DropTable
DROP TABLE "flights";

-- DropTable
DROP TABLE "seed_pairs";

-- DropEnum
DROP TYPE "FlightStatus";

-- CreateTable
CREATE TABLE "seed_chains" (
    "id" UUID NOT NULL,
    "commitment" CHAR(64) NOT NULL,
    "top_seed" CHAR(64) NOT NULL,
    "length" INTEGER NOT NULL,
    "salt" VARCHAR(100) NOT NULL,
    "next_index" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seed_chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rounds" (
    "id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "chain_id" UUID NOT NULL,
    "chain_index" INTEGER NOT NULL,
    "seed" CHAR(64) NOT NULL,
    "edge_bps" INTEGER NOT NULL,
    "crash_x100" BIGINT NOT NULL,
    "status" "RoundStatus" NOT NULL DEFAULT 'BETTING',
    "cap_x100" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "bet_minor" BIGINT NOT NULL,
    "auto_cashout_x100" INTEGER,
    "personal_cap_x100" INTEGER NOT NULL,
    "cap_x100" INTEGER NOT NULL,
    "max_payout_minor" BIGINT NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'OPEN',
    "settle_at" TIMESTAMPTZ(3),
    "cashout_x100" INTEGER,
    "cashout_reason" VARCHAR(20),
    "payout_minor" BIGINT,
    "settled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bet_journal_id" UUID NOT NULL,
    "payout_journal_id" UUID,

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seed_chains_commitment_key" ON "seed_chains"("commitment");

-- CreateIndex
CREATE UNIQUE INDEX "rounds_number_key" ON "rounds"("number");

-- CreateIndex
CREATE INDEX "rounds_status_idx" ON "rounds"("status");

-- CreateIndex
CREATE UNIQUE INDEX "rounds_chain_id_chain_index_key" ON "rounds"("chain_id", "chain_index");

-- CreateIndex
CREATE UNIQUE INDEX "bets_bet_journal_id_key" ON "bets"("bet_journal_id");

-- CreateIndex
CREATE UNIQUE INDEX "bets_payout_journal_id_key" ON "bets"("payout_journal_id");

-- CreateIndex
CREATE INDEX "bets_user_id_created_at_idx" ON "bets"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "bets_status_settle_at_idx" ON "bets"("status", "settle_at");

-- CreateIndex
CREATE UNIQUE INDEX "bets_round_id_user_id_key" ON "bets"("round_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "bets_user_id_idempotency_key_key" ON "bets"("user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "seed_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── Protections ─────────────
ALTER TABLE "seed_chains" ADD CONSTRAINT "seed_chains_valid" CHECK (length > 0 AND next_index BETWEEN 1 AND length + 1);
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_crash_valid" CHECK (crash_x100 >= 100);
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_cap_valid" CHECK (cap_x100 IS NULL OR cap_x100 >= 101);
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_ended_shape" CHECK ((status = 'ENDED') = (ended_at IS NOT NULL));
-- Only one round is open (betting or flying) at a time.
CREATE UNIQUE INDEX "rounds_one_open" ON "rounds" ((true)) WHERE status <> 'ENDED';

ALTER TABLE "bets" ADD CONSTRAINT "bets_bet_positive" CHECK (bet_minor > 0);
ALTER TABLE "bets" ADD CONSTRAINT "bets_cap_valid" CHECK (cap_x100 >= 101 AND cap_x100 <= personal_cap_x100 AND max_payout_minor >= bet_minor);
ALTER TABLE "bets" ADD CONSTRAINT "bets_auto_valid" CHECK (auto_cashout_x100 IS NULL OR auto_cashout_x100 >= 101);
ALTER TABLE "bets" ADD CONSTRAINT "bets_settled_shape" CHECK (
  (status = 'OPEN' AND settled_at IS NULL AND payout_minor IS NULL AND cashout_x100 IS NULL)
  OR (status = 'BUSTED' AND settled_at IS NOT NULL AND payout_minor IS NULL AND cashout_x100 IS NULL)
  OR (status = 'CASHED_OUT' AND settled_at IS NOT NULL AND payout_minor IS NOT NULL AND payout_journal_id IS NOT NULL
      AND cashout_x100 >= 101 AND cashout_x100 <= cap_x100 AND payout_minor <= max_payout_minor)
);
