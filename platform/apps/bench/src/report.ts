import { type Money, format, money, sum } from '@vidgen/shared';
import type { Category } from './fixtures.ts';
import { ACCEPTABLE_FIDELITY, type AttemptRecord } from './types.ts';

export interface ProviderSummary {
  readonly providerId: string;
  readonly model: string;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly successRate: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly estimatedTotal: Money;
  readonly billedTotal: Money;
  /** Rows carrying a provider-reported cost. A low count means the estimate/billed
   *  gap below is not yet trustworthy. */
  readonly billedCoverage: number;
  readonly scored: number;
  readonly meanFidelity: number | null;
  /** THE number: mean attempts to reach fidelity >= ACCEPTABLE_FIDELITY. */
  readonly regenerationRate: number | null;
  /** Fixtures never reaching an acceptable score within the attempts run. */
  readonly unresolvedFixtures: readonly string[];
  readonly costPerAcceptableShot: Money | null;
}

export interface CategorySummary {
  readonly category: Category;
  readonly providerId: string;
  readonly meanFidelity: number | null;
  readonly regenerationRate: number | null;
}

export function summarize(records: readonly AttemptRecord[]): ProviderSummary[] {
  const byProvider = groupBy(records, (r) => `${r.providerId}::${r.model}`);

  return [...byProvider.entries()]
    .map(([key, rows]) => {
      const [providerId = '', model = ''] = key.split('::');
      const succeeded = rows.filter((r) => r.outcome === 'succeeded');
      const latencies = succeeded.map((r) => r.latencyMs).sort((a, b) => a - b);
      const currency = rows[0]?.currency ?? 'USD';

      const billedRows = rows.filter((r) => r.billedMicros !== undefined);
      const scored = rows.filter((r) => typeof r.fidelity === 'number');

      const { rate, unresolved } = regenerationRate(rows);

      const billedTotal = sum(
        billedRows.map((r) => money(BigInt(r.billedMicros as string), currency)),
        currency,
      );

      const acceptableCount = rows.filter(
        (r) => (r.fidelity ?? 0) >= ACCEPTABLE_FIDELITY,
      ).length;

      // Spend across ALL attempts divided by shots that actually came out
      // acceptable. This, not the per-second rate, is the real unit cost.
      const spend = billedRows.length ? billedTotal : estimatedTotalOf(rows, currency);

      return {
        providerId,
        model,
        attempts: rows.length,
        succeeded: succeeded.length,
        failed: rows.length - succeeded.length,
        successRate: rows.length ? succeeded.length / rows.length : 0,
        latencyP50Ms: percentile(latencies, 0.5),
        latencyP95Ms: percentile(latencies, 0.95),
        estimatedTotal: estimatedTotalOf(rows, currency),
        billedTotal,
        billedCoverage: rows.length ? billedRows.length / rows.length : 0,
        scored: scored.length,
        meanFidelity: scored.length
          ? scored.reduce((a, r) => a + (r.fidelity ?? 0), 0) / scored.length
          : null,
        regenerationRate: rate,
        unresolvedFixtures: unresolved,
        costPerAcceptableShot: acceptableCount
          ? money(spend.micros / BigInt(acceptableCount), currency)
          : null,
      } satisfies ProviderSummary;
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/**
 * Mean attempts needed to reach an acceptable shot.
 *
 * Only fixtures that actually got there are counted, because a fixture that
 * never succeeded has no defined attempt count - averaging in the attempt cap
 * would silently understate the true rate. Those fixtures are reported
 * separately as `unresolved`, and a large unresolved list means the headline
 * number is optimistic.
 */
export function regenerationRate(rows: readonly AttemptRecord[]): {
  rate: number | null;
  unresolved: string[];
} {
  const byFixture = groupBy(rows, (r) => r.fixtureId);
  const firstAcceptable: number[] = [];
  const unresolved: string[] = [];

  for (const [fixtureId, attempts] of byFixture) {
    const scored = attempts.filter((a) => typeof a.fidelity === 'number');
    if (!scored.length) continue; // not yet scored - not the same as unresolved

    const hit = scored
      .filter((a) => (a.fidelity ?? 0) >= ACCEPTABLE_FIDELITY)
      .sort((a, b) => a.attempt - b.attempt)[0];

    if (hit) firstAcceptable.push(hit.attempt);
    else unresolved.push(fixtureId);
  }

  return {
    rate: firstAcceptable.length
      ? firstAcceptable.reduce((a, b) => a + b, 0) / firstAcceptable.length
      : null,
    unresolved: unresolved.sort(),
  };
}

export function summarizeByCategory(records: readonly AttemptRecord[]): CategorySummary[] {
  const groups = groupBy(records, (r) => `${r.category}::${r.providerId}`);
  return [...groups.entries()]
    .map(([key, rows]) => {
      const [category = '', providerId = ''] = key.split('::');
      const scored = rows.filter((r) => typeof r.fidelity === 'number');
      return {
        category: category as Category,
        providerId,
        meanFidelity: scored.length
          ? scored.reduce((a, r) => a + (r.fidelity ?? 0), 0) / scored.length
          : null,
        regenerationRate: regenerationRate(rows).rate,
      } satisfies CategorySummary;
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.providerId.localeCompare(b.providerId));
}

export function renderMarkdown(records: readonly AttemptRecord[]): string {
  const summaries = summarize(records);
  const categories = summarizeByCategory(records);
  const out: string[] = ['# Phase 0 benchmark report', ''];

  if (!records.length) {
    out.push('No attempts recorded yet. Run `bench run` first.');
    return out.join('\n');
  }

  out.push(`${records.length} attempts across ${summaries.length} provider/model pairs.`, '');
  out.push('## Providers', '');
  out.push(
    '| Provider | Model | Attempts | Success | p50 latency | p95 latency | Est. total | Billed total | Mean fidelity | Regen rate | Cost / acceptable shot |',
    '| :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |',
  );
  for (const s of summaries) {
    out.push(
      `| ${s.providerId} | ${s.model} | ${s.attempts} | ${pct(s.successRate)} | ${s.latencyP50Ms}ms | ${s.latencyP95Ms}ms | ${format(s.estimatedTotal)} | ${s.billedCoverage > 0 ? format(s.billedTotal) : '—'} | ${s.meanFidelity?.toFixed(2) ?? '—'} | ${s.regenerationRate?.toFixed(2) ?? '—'} | ${s.costPerAcceptableShot ? format(s.costPerAcceptableShot) : '—'} |`,
    );
  }

  out.push('', '## Fidelity by category', '');
  out.push('| Category | Provider | Mean fidelity | Regen rate |', '| :-- | :-- | --: | --: |');
  for (const c of categories) {
    out.push(
      `| ${c.category} | ${c.providerId} | ${c.meanFidelity?.toFixed(2) ?? '—'} | ${c.regenerationRate?.toFixed(2) ?? '—'} |`,
    );
  }

  const unscored = records.filter((r) => typeof r.fidelity !== 'number').length;
  const warnings: string[] = [];
  if (unscored) {
    warnings.push(
      `${unscored} of ${records.length} attempts are unscored. Regeneration rate and cost-per-acceptable-shot are computed only from scored attempts — run \`bench score\` before trusting them.`,
    );
  }
  for (const s of summaries) {
    if (s.billedCoverage === 0) {
      warnings.push(
        `${s.providerId} reported no billed cost on any attempt; its cost column is the *estimate*, not measured. Reconcile against the provider invoice before seeding pricing.`,
      );
    }
    if (s.unresolvedFixtures.length) {
      warnings.push(
        `${s.providerId} never reached an acceptable score on: ${s.unresolvedFixtures.join(', ')}. Its regeneration rate is optimistic.`,
      );
    }
  }
  if (warnings.length) {
    out.push('', '## Warnings', '');
    for (const w of warnings) out.push(`- ${w}`);
  }

  return out.join('\n');
}

function estimatedTotalOf(rows: readonly AttemptRecord[], currency: 'USD' | 'IQD'): Money {
  return sum(
    rows.map((r) => money(BigInt(r.estimatedMicros), currency)),
    currency,
  );
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = m.get(k);
    if (bucket) bucket.push(item);
    else m.set(k, [item]);
  }
  return m;
}

/** Nearest-rank percentile. Returns 0 for an empty set. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
