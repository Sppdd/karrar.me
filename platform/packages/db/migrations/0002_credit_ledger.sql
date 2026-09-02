-- Credit ledger. See docs/04-cost-and-data.md.
--
-- Append-only, double-entry. docs/04 calls this "the one place in the system
-- where getting cute costs you real money and unfalsifiable support tickets",
-- so every invariant below is enforced by the DATABASE, not by application
-- discipline. A future bug in a service method must not be able to corrupt the
-- journal.
--
-- Four accounts per org, so every transaction balances within a single org and
-- the invariant stays a simple per-transaction sum:
--
--   available   spendable credits
--   reserved    held against in-flight generations
--   purchased   contra: lifetime credits bought
--   consumed    contra: lifetime credits spent
--
-- The four movements, each summing to zero:
--
--   top-up 1000   purchased -1000   available +1000
--   reserve  50   available   -50   reserved    +50
--   settle   45   reserved    -50   consumed    +45   available +5
--   refund   50   reserved    -50   available   +50
--
-- Settle releases the unspent remainder in the same transaction, which makes an
-- over-estimate self-correcting rather than a slow leak.
--
-- Credits are whole bigint units - the internal unit from docs/07, decoupled
-- from both IQD and USD so FX drift between purchase and spend is absorbed by
-- the margin buffer rather than repriced at a user mid-project.

CREATE TYPE credit_account AS ENUM ('available', 'reserved', 'purchased', 'consumed');

CREATE TYPE ledger_entry_type AS ENUM ('topup', 'reserve', 'settle', 'refund', 'adjustment');

CREATE TABLE credit_ledger (
  id              bigserial PRIMARY KEY,
  -- Groups the balanced entries of one movement.
  transaction_id  uuid NOT NULL,
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  account         credit_account NOT NULL,
  entry_type      ledger_entry_type NOT NULL,
  -- Signed, in whole credits. Zero-amount entries are noise, not data.
  amount          bigint NOT NULL CHECK (amount <> 0),
  generation_id   uuid REFERENCES generations(id) ON DELETE SET NULL,
  payment_id      uuid,
  -- Set on externally-triggered movements (a webhook, a Temporal activity).
  -- NULL for the internal legs; the partial unique index below only guards the
  -- entries that can actually be replayed.
  idempotency_key text,
  memo            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_ledger_org_account_idx ON credit_ledger (org_id, account);
CREATE INDEX credit_ledger_txn_idx ON credit_ledger (transaction_id);
CREATE INDEX credit_ledger_generation_idx ON credit_ledger (generation_id)
  WHERE generation_id IS NOT NULL;

-- A Temporal retry or a redelivered gateway webhook must not double-credit.
CREATE UNIQUE INDEX credit_ledger_idempotency_idx
  ON credit_ledger (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- --------------------------------------------------------------------------
-- Invariant 1: append-only.
-- Corrections are compensating entries, never edits. An UPDATE or DELETE on a
-- financial journal is always a bug or an attack; there is no legitimate case.
-- --------------------------------------------------------------------------
CREATE FUNCTION credit_ledger_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'credit_ledger is append-only: % rejected. Post a compensating entry instead.',
    TG_OP;
END;
$$;

CREATE TRIGGER credit_ledger_no_update
  BEFORE UPDATE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_immutable();

CREATE TRIGGER credit_ledger_no_delete
  BEFORE DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_immutable();

-- TRUNCATE does NOT fire row-level DELETE triggers, so without this the two
-- above are not actually a guarantee - one statement would empty the journal.
-- Statement-level, because TRUNCATE has no rows to iterate.
CREATE TRIGGER credit_ledger_no_truncate
  BEFORE TRUNCATE ON credit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION credit_ledger_immutable();

-- --------------------------------------------------------------------------
-- Invariant 2: every transaction balances to zero.
--
-- DEFERRABLE INITIALLY DEFERRED because entries are inserted one at a time and
-- are only balanced once the whole set is in. Checking per-statement would
-- reject the first leg of every movement.
-- --------------------------------------------------------------------------
CREATE FUNCTION credit_ledger_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imbalance bigint;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO imbalance
  FROM credit_ledger
  WHERE transaction_id = NEW.transaction_id;

  IF imbalance <> 0 THEN
    RAISE EXCEPTION
      'credit_ledger transaction % does not balance: sum(amount) = %',
      NEW.transaction_id, imbalance;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER credit_ledger_balanced_check
  AFTER INSERT ON credit_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_balanced();

-- --------------------------------------------------------------------------
-- Invariant 3: the balance never goes negative.
--
-- docs/04 permits materialising the balance for read speed while the journal
-- stays authoritative. This row is also the LOCK TARGET that serialises
-- concurrent reserves - see reserve_credits() in src/ledger.ts.
--
-- Without that serialisation: two generations start at once against a balance
-- of 100, each reserving 80. Both read 100, both believe they can afford it,
-- both commit, and the org is 60 credits overdrawn. A CHECK alone does not
-- catch it, because each transaction validates against a snapshot the other has
-- not committed to yet.
-- --------------------------------------------------------------------------
CREATE TABLE credit_balances (
  org_id     uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  available  bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  reserved   bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Reconciliation: the materialised row must always equal the journal. Any row
-- returned by this view is a bug, and it is the query the nightly job runs.
CREATE VIEW credit_balance_drift AS
SELECT
  b.org_id,
  b.available AS materialised_available,
  COALESCE(j.available, 0) AS journal_available,
  b.reserved  AS materialised_reserved,
  COALESCE(j.reserved, 0)  AS journal_reserved
FROM credit_balances b
LEFT JOIN (
  SELECT
    org_id,
    sum(amount) FILTER (WHERE account = 'available') AS available,
    sum(amount) FILTER (WHERE account = 'reserved')  AS reserved
  FROM credit_ledger
  GROUP BY org_id
) j ON j.org_id = b.org_id
WHERE b.available <> COALESCE(j.available, 0)
   OR b.reserved  <> COALESCE(j.reserved, 0);
