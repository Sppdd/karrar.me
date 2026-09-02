import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { VideoProvider } from '@vidgen/providers';
import type { Fixture } from './fixtures.ts';
import { appendAttempt } from './store.ts';
import type { AttemptRecord } from './types.ts';

export interface RunOptions {
  readonly providers: readonly VideoProvider[];
  readonly fixtures: readonly Fixture[];
  readonly tier: 'draft' | 'final';
  /** Attempts per fixture per provider. >1 is what measures regeneration rate. */
  readonly attempts: number;
  readonly outPath: string;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly runId?: string;
  readonly onEvent?: (e: RunEvent) => void;
}

export type RunEvent =
  | { readonly kind: 'start'; readonly total: number; readonly runId: string }
  | { readonly kind: 'attempt'; readonly record: AttemptRecord; readonly done: number; readonly total: number }
  | { readonly kind: 'error'; readonly task: TaskId; readonly error: Error };

interface TaskId {
  readonly fixtureId: string;
  readonly providerId: string;
  readonly attempt: number;
}

/**
 * Idempotency key. Stable across process restarts for the same logical attempt,
 * so a resumed run reuses the provider's existing job instead of paying twice -
 * the same reason docs/04 requires keys derived from (generation_id, attempt).
 */
export function idempotencyKey(
  runId: string,
  fixtureId: string,
  providerId: string,
  tier: string,
  attempt: number,
): string {
  return createHash('sha256')
    .update([runId, fixtureId, providerId, tier, attempt].join(':'))
    .digest('hex')
    .slice(0, 32);
}

export async function run(opts: RunOptions): Promise<AttemptRecord[]> {
  const runId = opts.runId ?? randomUUID();
  const tasks: { fixture: Fixture; provider: VideoProvider; attempt: number }[] = [];

  for (const fixture of opts.fixtures) {
    for (const provider of opts.providers) {
      for (let attempt = 1; attempt <= opts.attempts; attempt++) {
        tasks.push({ fixture, provider, attempt });
      }
    }
  }

  opts.onEvent?.({ kind: 'start', total: tasks.length, runId });

  const results: AttemptRecord[] = [];
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      const task = tasks[i];
      if (!task) return;

      try {
        const rec = await runOne(runId, task.fixture, task.provider, task.attempt, opts);
        results.push(rec);
        await appendAttempt(opts.outPath, rec);
        opts.onEvent?.({ kind: 'attempt', record: rec, done: ++done, total: tasks.length });
      } catch (error) {
        done++;
        opts.onEvent?.({
          kind: 'error',
          task: {
            fixtureId: task.fixture.id,
            providerId: task.provider.id,
            attempt: task.attempt,
          },
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, tasks.length)) }, worker),
  );

  return results;
}

async function runOne(
  runId: string,
  fixture: Fixture,
  provider: VideoProvider,
  attempt: number,
  opts: RunOptions,
): Promise<AttemptRecord> {
  const key = idempotencyKey(runId, fixture.id, provider.id, opts.tier, attempt);
  const estimated = provider.estimate(fixture.spec, opts.tier);
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const common = {
    runId,
    fixtureId: fixture.id,
    category: fixture.category,
    providerId: provider.id,
    model: provider.model,
    tier: opts.tier,
    attempt,
    idempotencyKey: key,
    durationS: fixture.spec.duration_s,
    startedAt,
    estimatedMicros: estimated.micros.toString(),
    currency: estimated.currency,
  } as const;

  try {
    const handle = await provider.generate(fixture.spec, { idempotencyKey: key, tier: opts.tier });
    const status = await pollToCompletion(provider, handle, opts);
    const latencyMs = Math.round(performance.now() - t0);

    if (status.state === 'succeeded') {
      return {
        ...common,
        latencyMs,
        outcome: 'succeeded',
        clipUrl: status.clipUrl,
        ...(status.billedCost && { billedMicros: status.billedCost.micros.toString() }),
      };
    }
    return {
      ...common,
      latencyMs,
      outcome: 'failed',
      failureReason: status.state === 'failed' ? status.reason : `timed out in ${status.state}`,
    };
  } catch (error) {
    return {
      ...common,
      latencyMs: Math.round(performance.now() - t0),
      outcome: 'failed',
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

type Terminal =
  | { state: 'succeeded'; clipUrl: string; billedCost?: { micros: bigint } }
  | { state: 'failed'; reason: string }
  | { state: 'pending' | 'running' };

async function pollToCompletion(
  provider: VideoProvider,
  handle: Parameters<VideoProvider['poll']>[0],
  opts: RunOptions,
): Promise<Terminal> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const status = await provider.poll(handle);
    if (status.state === 'succeeded' || status.state === 'failed') return status;
    if (Date.now() >= deadline) return status;
    await sleep(opts.pollIntervalMs);
  }
}
