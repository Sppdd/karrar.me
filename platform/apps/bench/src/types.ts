import type { Currency } from '@vidgen/shared';
import type { Category } from './fixtures.ts';

/** One provider call. Mirrors the `generations` table in docs/04 - one row per
 *  provider call, not per shot, which is what makes regeneration rate
 *  measurable and cost reconcilable. */
export interface AttemptRecord {
  readonly runId: string;
  readonly fixtureId: string;
  readonly category: Category;
  readonly providerId: string;
  readonly model: string;
  readonly tier: 'draft' | 'final';
  /** 1-based. Attempt N of the same fixture, for regeneration-rate measurement. */
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly durationS: number;

  readonly startedAt: string;
  readonly latencyMs: number;

  readonly outcome: 'succeeded' | 'failed';
  readonly clipUrl?: string;
  readonly failureReason?: string;

  /** From the pricing table, before the call. */
  readonly estimatedMicros: string;
  /** From the provider response where it reports one. The gap between this and
   *  estimated is where the margin lives. */
  readonly billedMicros?: string;
  readonly currency: Currency;

  /** Human fidelity score, 1-5, filled in later by `bench score`. */
  readonly fidelity?: number;
  readonly scoredAt?: string;
  readonly scoreNote?: string;
}

export const ACCEPTABLE_FIDELITY = 4;
