# Overview

> An AI video-generation platform. This document set is the build plan.
> Implementation lives in its own repository — see [Repo layout](#repo-layout).

## The spine

Everything reduces to one loop. Build it end to end before anything else:

```
brand profile → story beat → shot list → generated clips → assembled 15–30s video → export
```

Character consistency, the style library, and reference-clip generation are
layers you add **on top of a working loop**, not parallel workstreams. A team
that builds them in parallel ships none of them.

## MVP definition (8–10 weeks)

One vertical video. 4–6 shots. One recurring character. One style preset.
Accurate cost shown before generation.

That is the whole scope. Anything else is Phase 3+.

## The two things most likely to sink this

**Regeneration rate.** If users need five attempts to get an acceptable shot,
the cost model breaks — a $3 video becomes a $15 video and the margin is gone.
This is a product number, not an infrastructure number, and it is the single
most important figure in the business. Instrument it from the first generation
call, and design the UI to drive it down: draft mode, per-shot regeneration,
and shot-spec editing instead of prompt rewriting.

**Rights on reference material.** Users will want to upload clips from films and
series they like. Content reuse is not defensible; *style descriptor extraction*
is. That distinction has to be in the architecture now — see
[04-cost-and-data.md](04-cost-and-data.md#reference-clips--style-extraction-not-content-reuse) —
because retrofitting it after launch means throwing away stored frames you
should never have kept. Get a lawyer's read before launch.

## Repo layout

The platform is a **separate repository**. This one (`karrar.me`) is a personal
site; a static GitHub Pages build and a SaaS with Postgres, Redis, Temporal, and
ffmpeg workers have nothing useful to share. The docs live here only because
this is where the planning happened.

The platform repo is a monorepo:

```
apps/web          Next.js client
apps/api          NestJS API
workers/ts        Temporal activities: script, shot list, ledger
workers/py        Temporal activities: scene detection, vision, ffmpeg
packages/shared   shot spec schema (zod) + generated types
infra/            migrations, docker-compose, deploy
```

## Document map

| Doc | Covers |
| :-- | :-- |
| [01-architecture.md](01-architecture.md) | Services, orchestration, provider adapters |
| [02-shot-spec.md](02-shot-spec.md) | The structured shot object — the core differentiator |
| [03-character-continuity.md](03-character-continuity.md) | Keeping a character the same across shots |
| [04-cost-and-data.md](04-cost-and-data.md) | Cost engine, credit ledger, data model, scaling |
| [05-phasing.md](05-phasing.md) | What ships when, and what Phase 0 must measure |
| [06-auth.md](06-auth.md) | Google OAuth, sessions, org bootstrapping |
| [07-payments.md](07-payments.md) | Iraqi payment rails, credit top-ups, FX |
