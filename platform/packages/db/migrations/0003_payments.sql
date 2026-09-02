-- Payments. See docs/07-payments.md.
--
-- Built on Wayl (wayl.io), an Iraqi payment aggregator and merchant of record
-- that fronts the local wallets through its "channels" concept - one
-- integration instead of separate FIB, ZainCash and Qi Card merchant
-- onboardings, each with its own CBI-regulated KYC.
--
-- Wayl's hosted checkout is redirect-based and one-shot, which confirms the
-- billing model: prepaid credit top-ups, not subscriptions.

CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'expired', 'refunded');

CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  gateway           text NOT NULL DEFAULT 'wayl',

  -- Our id, sent to Wayl as `referenceId`. Doubles as the idempotency key: the
  -- gateway itself rejects a duplicate, so a retried create cannot open a
  -- second billable checkout.
  reference_id      text NOT NULL,
  -- Wayl's own identifiers, filled in from the create response.
  gateway_ref       text,
  checkout_url      text,

  status            payment_status NOT NULL DEFAULT 'pending',

  -- What the customer pays, in the gateway's currency.
  -- bigint minor units + explicit currency. The IQD minor-unit convention
  -- (ISO 4217 says three decimals; Iraqi gateways transact in whole dinars)
  -- MUST be confirmed against a Wayl sandbox before go-live: guessing wrong is
  -- a 1000x error in the direction of giving money away.
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  currency          text NOT NULL DEFAULT 'IQD',

  -- What they receive. Credits are the internal unit, so the FX rate is pinned
  -- HERE, at purchase time - drift between purchase and spend is absorbed by
  -- the margin buffer rather than repriced at a user mid-project (docs/07).
  credits           bigint NOT NULL CHECK (credits > 0),
  fx_rate_micros    bigint CHECK (fx_rate_micros IS NULL OR fx_rate_micros > 0),
  fx_quote_currency text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz,

  UNIQUE (gateway, reference_id)
);
CREATE INDEX payments_org_created_idx ON payments (org_id, created_at DESC);
-- Drives the sweep that rescues payments whose webhook never arrived.
CREATE INDEX payments_pending_idx ON payments (created_at) WHERE status = 'pending';

-- Webhooks are at-least-once and can arrive out of order. Keying on the
-- gateway's own event identity makes redelivery a no-op instead of a second
-- credit. The raw body is retained because the HMAC is computed over it and a
-- disputed payment is argued from bytes, not from a parsed object.
CREATE TABLE payment_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway       text NOT NULL DEFAULT 'wayl',
  event_id      text NOT NULL,
  payment_id    uuid REFERENCES payments(id) ON DELETE SET NULL,
  reference_id  text,
  status        text,
  raw_body      text NOT NULL,
  signature     text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (gateway, event_id)
);
CREATE INDEX payment_webhook_events_unprocessed_idx
  ON payment_webhook_events (received_at) WHERE processed_at IS NULL;
