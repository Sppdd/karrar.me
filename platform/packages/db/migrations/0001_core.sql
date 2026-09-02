-- Core schema. See docs/04-cost-and-data.md.
--
-- Money is ALWAYS bigint minor units with an explicit currency column. Never a
-- float, and never an assumed two decimal places: ISO 4217 gives IQD three
-- (fils) while Iraqi gateways transact in whole dinars, so the convention is
-- pinned per row, not inferred. See docs/07-payments.md.

-- gen_random_uuid() is in Postgres core since 13; no extension needed.

CREATE TABLE orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text,
  display_name text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness without depending on the citext extension.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

-- Tenancy from day one; retrofitting it is miserable (docs/04).
CREATE TABLE memberships (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        text NOT NULL,
  voice       text,
  palette     text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brands_org_idx ON brands (org_id);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  brand_id    uuid REFERENCES brands(id) ON DELETE SET NULL,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'generating', 'ready', 'failed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_org_idx ON projects (org_id);

-- One row per shot, holding the shot spec JSON. `spec_version` is lifted out of
-- the document so old specs can be found and migrated without scanning JSONB.
CREATE TABLE shots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position      int NOT NULL,
  spec_version  int NOT NULL,
  spec          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, position)
);

-- pricing_table: provider x model x resolution x second -> cost.
-- Versioned by effective date; a price change is a row insert, not a deploy.
CREATE TABLE pricing_table (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       text NOT NULL,
  model             text NOT NULL,
  resolution        text NOT NULL,
  per_second_micros bigint NOT NULL CHECK (per_second_micros >= 0),
  currency          text NOT NULL DEFAULT 'USD',
  effective_from    date NOT NULL,
  -- Phase 0 seeds this as 'estimate'; measured rows replace them.
  source            text NOT NULL CHECK (source IN ('estimate', 'measured', 'invoice')),
  UNIQUE (provider_id, model, resolution, effective_from)
);

-- ONE ROW PER PROVIDER CALL, not per shot. This is what makes regeneration rate
-- measurable and cost reconcilable (docs/04). Deliberately shaped to match
-- AttemptRecord in apps/bench/src/types.ts so Phase 0 results load directly.
CREATE TABLE generations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  shot_id           uuid REFERENCES shots(id) ON DELETE SET NULL,
  provider_id       text NOT NULL,
  model             text NOT NULL,
  tier              text NOT NULL CHECK (tier IN ('draft', 'final')),
  attempt           int NOT NULL CHECK (attempt >= 1),
  idempotency_key   text NOT NULL,
  duration_s        int NOT NULL CHECK (duration_s > 0),
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  provider_ref      text,
  clip_url          text,
  failure_reason    text,
  estimated_micros  bigint NOT NULL,
  billed_micros     bigint,
  currency          text NOT NULL DEFAULT 'USD',
  latency_ms        int,
  fidelity          int CHECK (fidelity BETWEEN 1 AND 5),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  -- A retry must reuse the provider's job, never create a second billable one.
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX generations_org_started_idx ON generations (org_id, started_at DESC);
CREATE INDEX generations_shot_idx ON generations (shot_id);

CREATE TABLE assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('clip', 'frame', 'render', 'reference')),
  storage_key text NOT NULL,
  bytes       bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_org_idx ON assets (org_id);
