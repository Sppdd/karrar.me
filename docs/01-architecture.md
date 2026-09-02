# Architecture

## System shape

```
Next.js client  ──REST + SSE──▶  API (NestJS, TypeScript)
                                      │
                                      ▼
                              Temporal (orchestrator)
                                      │ fan-out
        ┌─────────────┬───────────────┼───────────────┬──────────────┐
     script       shotlist         image           video         assembly
      (TS)          (TS)         (Python)        (Python)       (Python/ffmpeg)
                                      │
                                      ▼
                          Provider adapter layer
                    (Veo · Kling · Runway · Seedance)
                                      │
                                      ▼
                    S3 + CDN  ·  Postgres + pgvector  ·  Redis
```

## Why an orchestrator, not plain queues

A 30-second ad is 6–10 dependent long-running jobs. Each takes 30 seconds to
five minutes. Each can fail. Each costs real money.

That combination demands durable execution state, per-step retry policy, and
partial resume — if shot 4 of 6 fails, you re-run shot 4, not the workflow.
Temporal gives you all three as primitives. Building it on BullMQ means
hand-rolling a state machine, a retry ledger, and a resume protocol, and that is
reliably where projects like this die.

Use **Temporal**. Self-host it in Phase 1 (it is one `docker-compose` service
plus Postgres) and move to Temporal Cloud when operational load justifies it.

## Language split

Hybrid, split at the Temporal activity boundary:

- **TypeScript** — the NestJS API and every activity that touches the shot spec,
  the credit ledger, or provider dispatch. These share types with the Next.js
  client through `packages/shared`, so a shot-spec change is a compile error in
  the client rather than a runtime surprise.
- **Python** — PySceneDetect, frame extraction, vision descriptor calls, and
  ffmpeg assembly. This is where the ecosystem actually lives, and forcing it
  into Node means shelling out to Python anyway with none of the type safety you
  gained.

Temporal task queues are the seam. A TypeScript workflow schedules a Python
activity by name; the two never share a process, a dependency tree, or a deploy.
Keep activity payloads to JSON-serializable IDs and S3 keys — never blobs.

## Provider adapter layer

**Non-negotiable.** Video model pricing and quality shift every quarter. If
provider calls are inlined in workflow code, every price change is a refactor.

One internal interface, thin adapters behind it:

```ts
interface VideoProvider {
  readonly id: string;

  /** Static declaration: reference images? first/last frame? max duration? audio? */
  capabilities(): ProviderCapabilities;

  /** Pre-flight cost, from pricing_table. Never calls the provider. */
  estimate(spec: ShotSpec, tier: RenderTier): Money;

  /** Dispatch. Must be idempotent on idempotencyKey. */
  generate(spec: ShotSpec, opts: { idempotencyKey: string }): Promise<JobHandle>;

  /** Poll or resolve a webhook callback into a terminal status. */
  poll(handle: JobHandle): Promise<JobStatus>;
}

type RenderTier = 'draft' | 'final';
```

Two consequences worth stating explicitly:

**Prompt rendering is per-adapter.** The shot spec is the source of truth; each
adapter renders it into that provider's prompt dialect and parameter set. This
is the *only* place provider-specific string-building is allowed.

**Capability negotiation is real logic, not documentation.** Adapters differ on
what they accept — reference-image counts, first/last-frame conditioning, max
clip duration, native audio. The planner reads `capabilities()` and degrades
gracefully: if the chosen provider cannot take a first-frame condition, the
continuity chain silently falls back to reference-image conditioning rather than
failing the workflow.

**Cost routing falls out for free.** Draft tier routes to the cheap model, final
tier to the premium one, both from the same shot spec.

All providers in the current market expose async generation with webhook
callbacks. Prefer webhooks; keep polling as the fallback path, since a dropped
webhook must not strand a workflow.

## Async everywhere

No request holds a connection while a model runs. The client starts a job, gets
an ID, and subscribes to an SSE stream for progress. The API is stateless and
horizontally scalable; all durable state is in Postgres and Temporal.
