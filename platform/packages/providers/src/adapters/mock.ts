import type { Money, ShotSpec } from '@vidgen/shared';
import { estimateCost } from '../pricing.ts';
import { cameraClause, joinClauses, lookClause } from '../prompt.ts';
import type {
  GenerateOptions,
  JobHandle,
  JobStatus,
  ProviderCapabilities,
  RenderTier,
  VideoProvider,
} from '../types.ts';

export interface MockOptions {
  /** Simulated wall-clock latency in ms. */
  readonly latencyMs?: number;
  /** Probability [0,1] a job fails. Deterministic given `seed`. */
  readonly failureRate?: number;
  readonly seed?: number;
}

/**
 * A provider that costs nothing and returns instantly-ish.
 *
 * This exists so the entire harness - runner, concurrency, retry, scoring,
 * reporting - is testable and demonstrable before anyone has API keys or has
 * spent a cent. It is also the fixture for the unit tests.
 */
export class MockProvider implements VideoProvider {
  readonly id = 'mock';
  readonly model = 'mock-v1';

  #jobs = new Map<string, { spec: ShotSpec; readyAt: number; fails: boolean }>();
  #rng: () => number;
  #opts: Required<MockOptions>;

  constructor(opts: MockOptions = {}) {
    this.#opts = {
      latencyMs: opts.latencyMs ?? 50,
      failureRate: opts.failureRate ?? 0,
      seed: opts.seed ?? 1,
    };
    this.#rng = mulberry32(this.#opts.seed);
  }

  capabilities(): ProviderCapabilities {
    return {
      maxDurationS: 10,
      resolutions: ['480p', '720p', '1080p'],
      maxReferenceImages: 3,
      firstFrameConditioning: true,
      lastFrameConditioning: true,
      nativeAudio: false,
      aspectRatios: ['16:9', '9:16', '1:1'],
    };
  }

  estimate(spec: ShotSpec, tier: RenderTier): Money {
    // Borrows Kling's row so mock runs produce plausible cost aggregates.
    return estimateCost({
      providerId: 'kling',
      model: 'kling-3.0',
      resolution: tier === 'draft' ? '720p' : '1080p',
      durationS: spec.duration_s,
    });
  }

  renderPrompt(spec: ShotSpec): string {
    return joinClauses([spec.action, cameraClause(spec), lookClause(spec)]);
  }

  async generate(spec: ShotSpec, opts: GenerateOptions): Promise<JobHandle> {
    // Idempotent on the key, exactly as a real adapter must be.
    const existing = this.#jobs.get(opts.idempotencyKey);
    if (!existing) {
      this.#jobs.set(opts.idempotencyKey, {
        spec,
        readyAt: Date.now() + this.#opts.latencyMs,
        fails: this.#rng() < this.#opts.failureRate,
      });
    }
    return { providerId: this.id, ref: opts.idempotencyKey, submittedAt: Date.now() };
  }

  async poll(handle: JobHandle): Promise<JobStatus> {
    const job = this.#jobs.get(handle.ref);
    if (!job) return { state: 'failed', reason: 'unknown job ref', retryable: false };
    if (Date.now() < job.readyAt) return { state: 'running' };
    if (job.fails) return { state: 'failed', reason: 'simulated failure', retryable: true };
    return {
      state: 'succeeded',
      clipUrl: `mock://clip/${handle.ref}`,
      billedCost: this.estimate(job.spec, 'final'),
    };
  }
}

/** Small deterministic PRNG so failure injection is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
