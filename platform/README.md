# Phase 0 — provider benchmark

Phase 0 of the platform plan in [`../docs`](../docs). It answers the two
questions that determine whether the business works, **before** anything is
built around the answers:

1. What does a shot actually cost, per provider, from an invoice rather than a
   blog post?
2. **How many attempts does a user need to get an acceptable shot?**

The second number is the one that matters. At a 1.2× regeneration rate the unit
economics work; at 5× they do not, at any provider's per-second price. Measuring
it is the entire point of this harness.

> This directory is a self-contained project. It lives here because the planning
> happened here; it is meant to be lifted into its own repository
> (`git subtree split -P platform`) when Phase 1 starts. Nothing outside
> `platform/` is referenced.

## Quick start

```sh
npm install
npm test                       # 60 tests, no credentials needed
npm run bench -- estimate --provider veo,kling,runway --tier final --attempts 3
```

`estimate` prices a run from the pricing table without calling anything. Always
run it before `run`.

A full dry run of the whole loop, with no API keys and no spend:

```sh
npm run bench -- run    --provider mock --attempts 3 --poll 10
npm run bench -- score  --show-provider
npm run bench -- report
```

## Real providers

```sh
cp .env.example .env      # fill in the keys you have
npm run bench -- run --provider kling --category character-closeup --attempts 3 --yes
```

`run` refuses to touch a real provider without `--yes`, and prints the cost
estimate first. Every attempt is written to `results/attempts.jsonl` as it
completes, so a run that dies halfway keeps the work it already paid for.

## The loop

| Command | Does |
| :-- | :-- |
| `estimate` | Prices a run from the pricing table. No provider calls, no spend. |
| `run` | Dispatches generations, polls to completion, appends one row per call. |
| `score` | Blind human fidelity scoring, 1–5, over the recorded clips. |
| `report` | Cost, latency, fidelity, and **regeneration rate** per provider. |

`report` exits non-zero while the headline numbers still rest on unscored
attempts, so a wrapper script cannot mistake a half-finished run for a result.

### Scoring

Scoring is manual and blind by default — provider identity is hidden so the
judgement stays honest. No automated metric for "does the character still look
like the character" exists yet, and a convenient wrong number is worse here than
a slow right one.

It also works non-interactively, one answer per line (`score`, then note):

```sh
printf '5\nsharp\n2\nblurry\n' | npm run bench -- score
```

## What Phase 0 must produce

1. **Measured pricing** to replace the seeded estimates in
   `packages/providers/src/pricing.ts`. Every row there is currently
   `source: 'estimate'`, gathered from secondary sources in Sep 2026 and **not
   invoice-verified**.
2. **A baseline regeneration rate**, overall and per category. If
   `character-closeup` needs four attempts while `establishing` needs one, that
   is a product finding, not a footnote — it tells you where the shot-spec
   editor has to be good.
3. **Two providers chosen.** One is a single point of failure on availability
   and pricing; three is more adapter surface than a pre-MVP team can maintain.

## Before the first real run

The three real adapters are written to each provider's documented shape but
**have not been executed against a live key**. Confirming the wire format is the
first task of Phase 0, and the mapping is deliberately isolated so it is cheap
to correct:

| Adapter | Verify |
| :-- | :-- |
| `veo.ts` | `#toRequest` / `#fromOperation`, and the real reference-image ceiling (sources say 3 or 4) |
| `kling.ts` | create/query endpoints, and whether the query path differs for image2video |
| `runway.ts` | model identifiers, `ratio` values, and whether text-only shots need a different endpoint |

Everything outside those mapping functions — the runner, retries, idempotency,
scoring, reporting — is provider-agnostic and already covered by tests against
`MockProvider`.

Two things to record while you are in there: whether each provider returns a
**billed cost** in its response (the report shows measured cost only where it
does), and whether it honours an **idempotency key** (without one, a retry is a
double charge).

## Layout

```
packages/shared      shot spec (zod) + Money. No float arithmetic, ever.
packages/providers   VideoProvider interface, pricing table, adapters, registry
apps/bench           fixtures, runner, scoring, reporting, CLI
```

The 20 fixtures in `apps/bench/src/fixtures.ts` span five categories chosen to
stress different provider weaknesses: dialogue (lip-sync, audio), action
(temporal coherence), product-hero (materials, text), establishing (scale,
background stability), and character-closeup (identity consistency).

**Freeze the fixture set once Phase 0 starts.** Comparability across providers
and across time is the whole value; a fixture edited midway invalidates the
baseline it fed.
