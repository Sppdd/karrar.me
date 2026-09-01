# Cost engine, data model, and scaling

## Cost engine

You promised users an accurately calculated cost. That makes this a first-class
subsystem, not a utility function.

**`pricing_table`** — provider × model × resolution × second → cost. Seeded from
Phase 0 measurements, versioned by effective date. Never hardcode a price in
application code; a provider price change should be a row insert, not a deploy.

**Pre-flight estimate** — derived from the shot spec before the user confirms.
Show it, then hard-block if it exceeds their credit balance. An estimate that
appears after generation is not a feature.

**Credits ledger** — append-only, double-entry:

- **Reserve** on job start.
- **Settle** on completion, at actual cost.
- **Refund** on failure.

Never mutate a balance column. Balance is a sum over the ledger, materialized if
you need the read speed. This is the one place in the system where getting cute
costs you real money and unfalsifiable support tickets.

**Idempotency keys** on every provider call. Temporal *will* retry activities;
without idempotency keys, a retry is a double charge. The key should derive from
`(generation_id, attempt)` so it is stable across replays.

**Reconciliation** — log actual provider cost per clip, and reconcile nightly
against provider invoices. Your margin lives or dies on the gap between the
estimate and the invoice, and you cannot manage a number you do not measure.

**Draft mode** — 480p, cheap model, roughly 10% of final cost. Users iterate on
drafts and pay for one final render. This is simultaneously your best margin
lever and your best product feature, because it makes regeneration cheap enough
that users stop resenting it.

### Current price envelope

Order-of-magnitude only. **Re-measure in Phase 0 before building on these** —
this market re-prices quarterly, and these figures were gathered from secondary
sources, not from invoices.

| Model | Approx. cost/second |
| :-- | :-- |
| Veo 3.1 (tier-dependent; Vertex standard runs notably higher) | ~$0.15–0.40 |
| Kling 3.0 | ~$0.10 |
| Runway Gen-4 Turbo | ~$0.05 |
| Runway Gen-4.5 | ~$0.12–0.15 |

A finished 30-second ad is therefore **single-digit dollars of raw generation
before regenerations**. Which is the whole point: the regeneration multiplier,
not the per-second price, determines whether this business works. A 5× multiplier
turns a healthy margin into a loss at any of these price points.

## Data model

Postgres for all of it. pgvector for style and character embeddings. Redis for
job state and rate limiting. **Do not add a second database until forced** — a
document store you added "for flexibility" becomes the thing you cannot migrate.

Core tables:

| Table | Notes |
| :-- | :-- |
| `orgs`, `users` | Tenancy from day one; retrofitting it is miserable |
| `brands` | Brand profile: voice, palette, logo assets |
| `series` | Holds characters, locations, palette for cross-episode continuity |
| `characters` | The character bible |
| `style_presets` | Versioned; authored in-house |
| `projects` | One video |
| `shots` | One row per shot, holding the shot spec JSON |
| `generations` | **One row per provider call**, with cost and status |
| `assets` | S3 references: clips, frames, renders |
| `credit_ledger` | Append-only, double-entry |
| `reference_clips` | Uploaded source material |
| `clip_descriptors` | Extracted style descriptors |

`generations` is the important one. One row per provider call — not per shot —
is what makes regeneration rate measurable, cost reconcilable, and retries
auditable. Every question you will want to answer in month three is a query
against this table.

## Reference clips — style extraction, not content reuse

Users want to point at a film they like and get something similar. Build that as
**descriptor extraction**, never content reuse:

```
upload → shot-boundary detection (PySceneDetect) → sample frames
       → vision model returns descriptors
       → store descriptor, discard or restrict source frames
       → generate new footage from the descriptor alone
```

The descriptors are structural: shot sizes, cut rhythm, color grade, lighting
setup, movement patterns. That is roughly 80% of the creative value the user
actually wanted, from a defensible position.

Copyrighted films and series are not safe training or conditioning inputs, and
providers will reject them at the API boundary anyway. The architectural
commitment is that **source frames never reach a generation call** — they exist
only long enough to be described.

This is the single biggest risk to the business, larger than any technical
choice here. Get counsel before launch.

## Scaling

**Stateless API, everything async.** No request holds a connection while a model
runs; SSE or polling for progress.

**Do not buy GPUs.** Use provider APIs until you have a proven, repeated
workload, then consider self-hosting one specific model. GPU capex before
product-market fit has killed more of these companies than bad models did.

**Queue partitioning by tier** so one bulk free user cannot starve paying ones.

**Aggressive caching of identical shot specs.** Users regenerate the same thing
constantly; a content-addressed cache keyed on the resolved spec plus provider
plus tier is close to free money.

**CDN + HLS** for playback. ffmpeg assembly workers on ordinary CPU instances,
autoscaled on queue depth.

## Frontend

Next.js + Tailwind + shadcn/ui.

**Three responsive layouts, not one fluid one:**

- **Mobile** — single column, shot cards stacked.
- **Tablet** — timeline + preview.
- **Desktop** — timeline + preview + inspector.

The shot-list editor **is** the app. Spend the design time there and nowhere
else. Every hour spent on the marketing page instead of the shot inspector is an
hour not spent on the thing that lowers regeneration rate.
