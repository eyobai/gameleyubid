-- Two bets per player per round (slot 1 and 2), bets cancellable before lift-off, and chat.
DROP INDEX "bets_round_id_user_id_key";
ALTER TABLE "bets" ADD COLUMN "cancel_journal_id" UUID, ADD COLUMN "slot" SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE "users" ADD COLUMN "chat_muted_until" TIMESTAMPTZ(3);

CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "text" VARCHAR(200) NOT NULL,
    "hidden_at" TIMESTAMPTZ(3),
    "hidden_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_messages_created_at_idx" ON "chat_messages"("created_at");
CREATE INDEX "chat_messages_user_id_created_at_idx" ON "chat_messages"("user_id", "created_at");
CREATE UNIQUE INDEX "bets_cancel_journal_id_key" ON "bets"("cancel_journal_id");
-- One live bet per player and slot; a cancelled bet frees its slot.
CREATE UNIQUE INDEX "bets_one_per_slot" ON "bets"("round_id", "user_id", "slot") WHERE status <> 'CANCELLED';
CREATE INDEX "bets_round_id_idx" ON "bets"("round_id");
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Protections ─────────────
ALTER TABLE "bets" ADD CONSTRAINT "bets_slot_valid" CHECK (slot IN (1, 2));
ALTER TABLE "bets" DROP CONSTRAINT "bets_settled_shape";
ALTER TABLE "bets" ADD CONSTRAINT "bets_settled_shape" CHECK (
  (status = 'OPEN' AND settled_at IS NULL AND payout_minor IS NULL AND cashout_x100 IS NULL AND cancel_journal_id IS NULL)
  OR (status = 'BUSTED' AND settled_at IS NOT NULL AND payout_minor IS NULL AND cashout_x100 IS NULL AND cancel_journal_id IS NULL)
  OR (status = 'CANCELLED' AND settled_at IS NOT NULL AND payout_minor IS NULL AND cashout_x100 IS NULL AND cancel_journal_id IS NOT NULL)
  OR (status = 'CASHED_OUT' AND settled_at IS NOT NULL AND payout_minor IS NOT NULL AND payout_journal_id IS NOT NULL
      AND cashout_x100 >= 101 AND cashout_x100 <= cap_x100 AND payout_minor <= max_payout_minor AND cancel_journal_id IS NULL)
);
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_text_valid" CHECK (length(btrim(text)) BETWEEN 1 AND 200);
