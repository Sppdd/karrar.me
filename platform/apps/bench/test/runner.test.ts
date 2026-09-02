import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@vidgen/providers';
import { FIXTURES } from '../src/fixtures.ts';
import { idempotencyKey, run } from '../src/runner.ts';
import { readAttempts } from '../src/store.ts';
import { applyScore, pipedAsker, scoreWith } from '../src/score.ts';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bench-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const opts = (extra: Partial<Parameters<typeof run>[0]> = {}) => ({
  providers: [new MockProvider({ latencyMs: 0 })],
  fixtures: FIXTURES.slice(0, 3),
  tier: 'draft' as const,
  attempts: 1,
  outPath: join(dir, 'attempts.jsonl'),
  concurrency: 2,
  pollIntervalMs: 1,
  timeoutMs: 5_000,
  runId: 'test-run',
  ...extra,
});

describe('runner', () => {
  it('records one row per provider call, as docs/04 requires', async () => {
    const o = opts({ attempts: 2 });
    const records = await run(o);
    expect(records).toHaveLength(6); // 3 fixtures x 1 provider x 2 attempts
    expect(await readAttempts(o.outPath)).toHaveLength(6);
  });

  it('persists each attempt as it completes, so a crash keeps paid-for work', async () => {
    const o = opts();
    const seen: number[] = [];
    await run({ ...o, onEvent: (e) => { if (e.kind === 'attempt') seen.push(e.done); } });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('derives a stable idempotency key so a resumed run does not double-charge', () => {
    const a = idempotencyKey('run', 'fx', 'veo', 'draft', 1);
    expect(a).toBe(idempotencyKey('run', 'fx', 'veo', 'draft', 1));
    expect(a).not.toBe(idempotencyKey('run', 'fx', 'veo', 'draft', 2));
    expect(a).not.toBe(idempotencyKey('run', 'fx', 'veo', 'final', 1));
  });

  it('records failures as rows rather than aborting the run', async () => {
    const records = await run(
      opts({ providers: [new MockProvider({ latencyMs: 0, failureRate: 1 })] }),
    );
    expect(records).toHaveLength(3);
    expect(records.every((r) => r.outcome === 'failed')).toBe(true);
    expect(records[0]?.failureReason).toBe('simulated failure');
  });

  it('captures an estimate on every row, including failed ones', async () => {
    const records = await run(
      opts({ providers: [new MockProvider({ latencyMs: 0, failureRate: 1 })] }),
    );
    // Failed generations still cost time; some providers bill for them too.
    expect(records.every((r) => BigInt(r.estimatedMicros) > 0n)).toBe(true);
  });

  it('respects the concurrency limit while covering every task', async () => {
    const records = await run(opts({ concurrency: 1, fixtures: FIXTURES.slice(0, 5) }));
    expect(new Set(records.map((r) => r.fixtureId)).size).toBe(5);
  });
});

describe('applyScore', () => {
  it('attaches fidelity to the matching row only', async () => {
    const o = opts();
    const all = await run(o);
    applyScore(all, all[1]!, 4, 'usable');
    expect(all[1]?.fidelity).toBe(4);
    expect(all[1]?.scoreNote).toBe('usable');
    expect(all[0]?.fidelity).toBeUndefined();
  });

  it('throws rather than silently dropping a score it cannot place', async () => {
    const all = await run(opts());
    expect(() => applyScore(all, { ...all[0]!, idempotencyKey: 'ghost' }, 3)).toThrow(/not found/);
  });
});

describe('pipedAsker', () => {
  it('serves every line in order, so batch scoring records more than one answer', async () => {
    // Regression: readline emits all buffered lines at once and drops those with
    // no pending question, so a piped session silently saved only its first score.
    const { ask } = pipedAsker('5\nsharp\n2\nblurry\n');
    expect(await ask('q1 ')).toBe('5');
    expect(await ask('n1 ')).toBe('sharp');
    expect(await ask('q2 ')).toBe('2');
    expect(await ask('n2 ')).toBe('blurry');
    expect(await ask('q3 ')).toBeNull();
  });

  it('does not treat a trailing newline as an empty answer', async () => {
    const { ask } = pipedAsker('4\n');
    expect(await ask('q ')).toBe('4');
    expect(await ask('q ')).toBeNull();
  });

  it('preserves blank lines as deliberate skips', async () => {
    const { ask } = pipedAsker('\n\n');
    expect(await ask('q ')).toBe('');
    expect(await ask('q ')).toBe('');
    expect(await ask('q ')).toBeNull();
  });
});

describe('scoreWith', () => {
  it('records scores from a non-interactive source and stops cleanly at EOF', async () => {
    const o = opts({ attempts: 2, fixtures: FIXTURES.slice(0, 2) });
    await run(o);
    const { ask } = pipedAsker('5\ngood\n3\n\n');
    const n = await scoreWith({ path: o.outPath, rescore: false, blind: false }, ask);
    expect(n).toBe(2);

    const saved = await readAttempts(o.outPath);
    expect(saved.filter((r) => typeof r.fidelity === 'number')).toHaveLength(2);
    expect(saved.find((r) => r.fidelity === 5)?.scoreNote).toBe('good');
  });

  it('saves the scores made before an early quit', async () => {
    const o = opts({ attempts: 2, fixtures: FIXTURES.slice(0, 2) });
    await run(o);
    const { ask } = pipedAsker('4\n\nq\n');
    expect(await scoreWith({ path: o.outPath, rescore: false, blind: false }, ask)).toBe(1);
    const saved = await readAttempts(o.outPath);
    expect(saved.filter((r) => typeof r.fidelity === 'number')).toHaveLength(1);
  });

  it('ignores out-of-range answers rather than storing them', async () => {
    const o = opts({ attempts: 1, fixtures: FIXTURES.slice(0, 2) });
    await run(o);
    const { ask } = pipedAsker('9\n0\n');
    expect(await scoreWith({ path: o.outPath, rescore: false, blind: false }, ask)).toBe(0);
  });

  it('leaves already-scored rows alone unless rescoring', async () => {
    const o = opts({ attempts: 1, fixtures: FIXTURES.slice(0, 1) });
    await run(o);
    await scoreWith({ path: o.outPath, rescore: false, blind: false }, pipedAsker('5\n\n').ask);
    // Second pass has nothing to do; the score must survive it.
    expect(
      await scoreWith({ path: o.outPath, rescore: false, blind: false }, pipedAsker('1\n\n').ask),
    ).toBe(0);
    expect((await readAttempts(o.outPath))[0]?.fidelity).toBe(5);
  });
});
