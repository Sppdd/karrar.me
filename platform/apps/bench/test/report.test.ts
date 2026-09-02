import { describe, expect, it } from 'vitest';
import type { AttemptRecord } from '../src/types.ts';
import { percentile, regenerationRate, renderMarkdown, summarize } from '../src/report.ts';

const attempt = (o: Partial<AttemptRecord> & Pick<AttemptRecord, 'fixtureId' | 'attempt'>): AttemptRecord => ({
  runId: 'r1',
  category: 'character-closeup',
  providerId: 'veo',
  model: 'veo-3.1-fast',
  tier: 'draft',
  idempotencyKey: `${o.fixtureId}-${o.attempt}-${o.providerId ?? 'veo'}`,
  durationS: 4,
  startedAt: '2026-09-02T00:00:00.000Z',
  latencyMs: 1000,
  outcome: 'succeeded',
  estimatedMicros: '600000',
  currency: 'USD',
  ...o,
});

describe('regenerationRate', () => {
  it('is the mean attempt number at which a shot first becomes acceptable', () => {
    const rows = [
      attempt({ fixtureId: 'a', attempt: 1, fidelity: 2 }),
      attempt({ fixtureId: 'a', attempt: 2, fidelity: 5 }), // acceptable at 2
      attempt({ fixtureId: 'b', attempt: 1, fidelity: 4 }), // acceptable at 1
    ];
    expect(regenerationRate(rows).rate).toBe(1.5);
  });

  it('excludes never-acceptable fixtures instead of averaging in the attempt cap', () => {
    const rows = [
      attempt({ fixtureId: 'a', attempt: 1, fidelity: 5 }),
      attempt({ fixtureId: 'b', attempt: 1, fidelity: 1 }),
      attempt({ fixtureId: 'b', attempt: 2, fidelity: 2 }),
    ];
    const { rate, unresolved } = regenerationRate(rows);
    // Averaging b in as "3 attempts" would report 2.0 and understate the problem.
    expect(rate).toBe(1);
    expect(unresolved).toEqual(['b']);
  });

  it('is null when nothing has been scored', () => {
    expect(regenerationRate([attempt({ fixtureId: 'a', attempt: 1 })]).rate).toBeNull();
  });

  it('takes the earliest acceptable attempt even when scored out of order', () => {
    const rows = [
      attempt({ fixtureId: 'a', attempt: 3, fidelity: 5 }),
      attempt({ fixtureId: 'a', attempt: 1, fidelity: 4 }),
    ];
    expect(regenerationRate(rows).rate).toBe(1);
  });
});

describe('summarize', () => {
  it('separates providers and computes success rate and latency percentiles', () => {
    const rows = [
      attempt({ fixtureId: 'a', attempt: 1, latencyMs: 100 }),
      attempt({ fixtureId: 'b', attempt: 1, latencyMs: 300 }),
      attempt({ fixtureId: 'c', attempt: 1, outcome: 'failed', failureReason: 'x' }),
      attempt({ fixtureId: 'a', attempt: 1, providerId: 'kling', model: 'kling-3.0' }),
    ];
    const [kling, veo] = summarize(rows);
    expect(kling?.providerId).toBe('kling');
    expect(veo?.attempts).toBe(3);
    expect(veo?.succeeded).toBe(2);
    expect(veo?.successRate).toBeCloseTo(2 / 3);
    expect(veo?.latencyP50Ms).toBe(100);
    expect(veo?.latencyP95Ms).toBe(300);
  });

  it('divides total spend by acceptable shots, not by attempts', () => {
    // 3 attempts at 0.60 = 1.80 spent; only one shot came out acceptable.
    const rows = [
      attempt({ fixtureId: 'a', attempt: 1, fidelity: 1 }),
      attempt({ fixtureId: 'a', attempt: 2, fidelity: 2 }),
      attempt({ fixtureId: 'a', attempt: 3, fidelity: 5 }),
    ];
    const [s] = summarize(rows);
    expect(s?.costPerAcceptableShot?.micros).toBe(1_800_000n);
  });

  it('prefers billed cost over the estimate when the provider reports one', () => {
    const rows = [
      attempt({ fixtureId: 'a', attempt: 1, fidelity: 5, billedMicros: '900000' }),
    ];
    const [s] = summarize(rows);
    expect(s?.billedTotal.micros).toBe(900_000n);
    expect(s?.billedCoverage).toBe(1);
    expect(s?.costPerAcceptableShot?.micros).toBe(900_000n);
  });

  it('reports zero billed coverage rather than pretending the estimate was measured', () => {
    const [s] = summarize([attempt({ fixtureId: 'a', attempt: 1 })]);
    expect(s?.billedCoverage).toBe(0);
    expect(s?.billedTotal.micros).toBe(0n);
  });
});

describe('renderMarkdown', () => {
  it('warns loudly when the headline numbers rest on unscored attempts', () => {
    const md = renderMarkdown([attempt({ fixtureId: 'a', attempt: 1 })]);
    expect(md).toContain('## Warnings');
    expect(md).toContain('unscored');
    expect(md).toContain('reported no billed cost');
  });

  it('flags fixtures that never reached an acceptable score', () => {
    const md = renderMarkdown([
      attempt({ fixtureId: 'a', attempt: 1, fidelity: 5 }),
      attempt({ fixtureId: 'b', attempt: 1, fidelity: 1 }),
    ]);
    expect(md).toMatch(/never reached an acceptable score on: b/);
  });

  it('says so plainly when there is nothing to report', () => {
    expect(renderMarkdown([])).toContain('No attempts recorded yet');
  });
});

describe('percentile', () => {
  it('handles empty and single-element sets', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it('uses nearest-rank', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });
});
