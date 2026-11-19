-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PLAYER', 'FINANCE', 'ADMIN');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('PLAYER_WALLET', 'GAME_RESERVE', 'PAYMENT_CLEARING', 'OWNER_FUNDS');

-- CreateEnum
CREATE TYPE "JournalType" AS ENUM ('DEPOSIT', 'BET', 'PAYOUT', 'RESERVE_FUNDING', 'RESERVE_WITHDRAWAL');

-- CreateEnum
CREATE TYPE "EntryDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "FlightStatus" AS ENUM ('OPEN', 'CASHED_OUT', 'BUSTED');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone_number" VARCHAR(20) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'PLAYER',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "rotated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "type" "AccountType" NOT NULL,
    "user_id" UUID,
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "balance_minor" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journals" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(40) NOT NULL,
    "type" "JournalType" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "idempotency_key" VARCHAR(200),
    "description" VARCHAR(300),
    "metadata" JSONB,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "journal_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "balance_after_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_state" (
    "id" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seed_pairs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "server_seed" CHAR(64) NOT NULL,
    "server_seed_hash" CHAR(64) NOT NULL,
    "client_seed" VARCHAR(64) NOT NULL,
    "next_nonce" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealed_at" TIMESTAMPTZ(3),

    CONSTRAINT "seed_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flights" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "seed_pair_id" UUID NOT NULL,
    "nonce" INTEGER NOT NULL,
    "edge_bps" INTEGER NOT NULL,
    "bet_minor" BIGINT NOT NULL,
    "auto_cashout_x100" INTEGER,
    "cap_x100" INTEGER NOT NULL,
    "max_payout_minor" BIGINT NOT NULL,
    "crash_x100" BIGINT NOT NULL,
    "status" "FlightStatus" NOT NULL DEFAULT 'OPEN',
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "settle_at" TIMESTAMPTZ(3) NOT NULL,
    "cashout_x100" INTEGER,
    "cashout_reason" VARCHAR(20),
    "payout_minor" BIGINT,
    "settled_at" TIMESTAMPTZ(3),
    "bet_journal_id" UUID NOT NULL,
    "payout_journal_id" UUID,

    CONSTRAINT "flights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "reference" VARCHAR(40) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'INITIATED',
    "test_mode" BOOLEAN NOT NULL,
    "checkout_url" VARCHAR(500),
    "provider_reference" VARCHAR(100),
    "journal_id" UUID,
    "failure_reason" VARCHAR(300),
    "review_reason" VARCHAR(300),
    "last_checked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_events" (
    "id" UUID NOT NULL,
    "event_key" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "entity" VARCHAR(80) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_user_id_key" ON "ledger_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "journals_reference_key" ON "journals"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "journals_idempotency_key_key" ON "journals"("idempotency_key");

-- CreateIndex
CREATE INDEX "journals_type_created_at_idx" ON "journals"("type", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_sequence_idx" ON "ledger_entries"("account_id", "sequence");

-- CreateIndex
CREATE INDEX "ledger_entries_journal_id_idx" ON "ledger_entries"("journal_id");

-- CreateIndex
CREATE INDEX "seed_pairs_user_id_created_at_idx" ON "seed_pairs"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "flights_bet_journal_id_key" ON "flights"("bet_journal_id");

-- CreateIndex
CREATE UNIQUE INDEX "flights_payout_journal_id_key" ON "flights"("payout_journal_id");

-- CreateIndex
CREATE INDEX "flights_user_id_started_at_idx" ON "flights"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "flights_status_settle_at_idx" ON "flights"("status", "settle_at");

-- CreateIndex
CREATE UNIQUE INDEX "flights_user_id_idempotency_key_key" ON "flights"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "flights_seed_pair_id_nonce_key" ON "flights"("seed_pair_id", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_reference_key" ON "deposits"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_journal_id_key" ON "deposits"("journal_id");

-- CreateIndex
CREATE INDEX "deposits_status_created_at_idx" ON "deposits"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_user_id_idempotency_key_key" ON "deposits"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "provider_events_event_key_key" ON "provider_events"("event_key");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seed_pairs" ADD CONSTRAINT "seed_pairs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flights" ADD CONSTRAINT "flights_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flights" ADD CONSTRAINT "flights_seed_pair_id_fkey" FOREIGN KEY ("seed_pair_id") REFERENCES "seed_pairs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── Protections that the schema file cannot express ─────────────

-- Money is positive; balances never negative unless the account allows it.
ALTER TABLE "journals" ADD CONSTRAINT "journals_amount_positive" CHECK (amount_minor > 0);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_positive" CHECK (amount_minor > 0);
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_balance_allowed" CHECK (allow_negative OR balance_minor >= 0);
-- The reserve may never go below zero, whatever the flag says.
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_reserve_not_negative" CHECK (type <> 'GAME_RESERVE' OR balance_minor >= 0);
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164" CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$');

-- Flights: amounts and multipliers make sense, settled flights are complete.
ALTER TABLE "flights" ADD CONSTRAINT "flights_bet_positive" CHECK (bet_minor > 0);
ALTER TABLE "flights" ADD CONSTRAINT "flights_cap_valid" CHECK (cap_x100 >= 101 AND max_payout_minor >= bet_minor);
ALTER TABLE "flights" ADD CONSTRAINT "flights_crash_valid" CHECK (crash_x100 >= 100);
ALTER TABLE "flights" ADD CONSTRAINT "flights_auto_valid" CHECK (auto_cashout_x100 IS NULL OR auto_cashout_x100 >= 101);
ALTER TABLE "flights" ADD CONSTRAINT "flights_settle_after_start" CHECK (settle_at >= started_at);
ALTER TABLE "flights" ADD CONSTRAINT "flights_settled_shape" CHECK (
  (status = 'OPEN' AND settled_at IS NULL AND payout_minor IS NULL AND cashout_x100 IS NULL)
  OR (status = 'BUSTED' AND settled_at IS NOT NULL AND payout_minor IS NULL AND cashout_x100 IS NULL)
  OR (status = 'CASHED_OUT' AND settled_at IS NOT NULL AND payout_minor IS NOT NULL AND payout_journal_id IS NOT NULL
      AND cashout_x100 >= 101 AND cashout_x100 <= cap_x100 AND cashout_x100 <= crash_x100
      AND payout_minor <= max_payout_minor)
);
-- A player flies one balloon at a time.
CREATE UNIQUE INDEX "flights_one_open_per_user" ON "flights" ("user_id") WHERE status = 'OPEN';
-- A player has one active seed pair.
CREATE UNIQUE INDEX "seed_pairs_one_active_per_user" ON "seed_pairs" ("user_id") WHERE active;
ALTER TABLE "seed_pairs" ADD CONSTRAINT "seed_pairs_revealed_when_retired" CHECK (active OR revealed_at IS NOT NULL);

ALTER TABLE "deposits" ADD CONSTRAINT "deposits_amount_positive" CHECK (amount_minor > 0);
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_succeeded_has_journal" CHECK (status <> 'SUCCEEDED' OR journal_id IS NOT NULL);

-- The single row that serializes commitments of the reserve.
INSERT INTO "game_state" ("id") VALUES (1);

-- Ledger entries and journals are append-only.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be changed or deleted', TG_TABLE_NAME;
END $$;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON "journals" FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Every journal balances at commit: debits = credits = journal amount.
CREATE FUNCTION check_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d BIGINT; c BIGINT; amt BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0),
         COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)
    INTO d, c FROM ledger_entries WHERE journal_id = NEW.journal_id;
  SELECT amount_minor INTO amt FROM journals WHERE id = NEW.journal_id;
  IF d <> c OR d <> amt THEN
    RAISE EXCEPTION 'Journal % is unbalanced: debits %, credits %, amount %', NEW.journal_id, d, c, amt;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();
