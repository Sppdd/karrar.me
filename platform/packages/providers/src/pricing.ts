import { type Money, fromDecimal, scale } from '@vidgen/shared';
import type { Resolution } from './types.ts';

/**
 * pricing_table (docs/04). Provider x model x resolution x second -> cost.
 *
 * Versioned by effective date and never hardcoded at a call site: a provider
 * price change is a row insert, not a deploy. In the platform this is a
 * Postgres table; here it is a seed file, and the whole point of Phase 0 is to
 * REPLACE these numbers with measured ones.
 *
 * PROVENANCE: gathered from secondary sources (vendor pages, comparison blogs)
 * in Sep 2026, NOT from invoices. Treat as order-of-magnitude only. The
 * benchmark records `billedCost` from each provider response where available;
 * `bench report --emit-pricing` regenerates this file from those measurements.
 */
export interface PricingRow {
  readonly providerId: string;
  readonly model: string;
  readonly resolution: Resolution;
  /** Cost per second of generated video. */
  readonly perSecond: Money;
  readonly effectiveFrom: string;
  readonly source: 'estimate' | 'measured' | 'invoice';
}

const est = (
  providerId: string,
  model: string,
  resolution: Resolution,
  perSecondUsd: number,
): PricingRow => ({
  providerId,
  model,
  resolution,
  perSecond: fromDecimal(perSecondUsd, 'USD'),
  effectiveFrom: '2026-09-01',
  source: 'estimate',
});

export const PRICING_TABLE: readonly PricingRow[] = [
  // Veo 3.1 - tiered. Vertex standard runs materially higher than the Gemini API
  // rate; these track the Gemini API tiers.
  est('veo', 'veo-3.1-light', '720p', 0.05),
  est('veo', 'veo-3.1-fast', '720p', 0.15),
  est('veo', 'veo-3.1-fast', '1080p', 0.15),
  est('veo', 'veo-3.1', '1080p', 0.4),
  est('veo', 'veo-3.1', '4k', 0.6),

  // Kling 3.0 - strongest multi-angle subject consistency of the current set,
  // which is why it stays in the routing table for character work (docs/03).
  est('kling', 'kling-3.0', '720p', 0.1),
  est('kling', 'kling-3.0', '1080p', 0.1),

  // Runway - a credit is a flat $0.01 on the developer API.
  est('runway', 'gen-4-turbo', '720p', 0.05),
  est('runway', 'gen-4.5', '1080p', 0.12),
];

export interface PriceLookup {
  readonly providerId: string;
  readonly model: string;
  readonly resolution: Resolution;
  /** Defaults to now. Pass a date to reproduce a historical estimate. */
  readonly asOf?: string;
}

/** Most recent row effective on or before `asOf`. */
export function lookupPrice(
  q: PriceLookup,
  table: readonly PricingRow[] = PRICING_TABLE,
): PricingRow | undefined {
  const asOf = q.asOf ?? new Date().toISOString().slice(0, 10);
  return table
    .filter(
      (r) =>
        r.providerId === q.providerId &&
        r.model === q.model &&
        r.resolution === q.resolution &&
        r.effectiveFrom <= asOf,
    )
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
}

export function estimateCost(q: PriceLookup & { durationS: number }): Money {
  const row = lookupPrice(q);
  if (!row) {
    throw new Error(
      `no pricing row for ${q.providerId}/${q.model}@${q.resolution} as of ${q.asOf ?? 'today'}`,
    );
  }
  if (!Number.isInteger(q.durationS) || q.durationS <= 0) {
    throw new RangeError(`durationS must be a positive integer, got ${q.durationS}`);
  }
  return scale(row.perSecond, BigInt(q.durationS), 1n);
}
