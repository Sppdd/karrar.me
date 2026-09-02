import { describe, expect, it } from 'vitest';
import { parseShotSpec } from '@vidgen/shared';
import { FIXTURES } from '../../../apps/bench/src/fixtures.ts';
import { MockProvider } from '../src/adapters/mock.ts';
import { KlingProvider } from '../src/adapters/kling.ts';
import { RunwayProvider } from '../src/adapters/runway.ts';
import { VeoProvider } from '../src/adapters/veo.ts';
import { ProviderConfigError } from '../src/types.ts';

const spec = parseShotSpec(FIXTURES[1]!.spec);

describe('prompt rendering', () => {
  it('renders every fixture to a non-empty prompt on every adapter', () => {
    for (const p of [new VeoProvider(), new KlingProvider(), new RunwayProvider()]) {
      for (const f of FIXTURES) {
        const prompt = p.renderPrompt(f.spec);
        expect(prompt.length).toBeGreaterThan(20);
        expect(prompt).not.toMatch(/undefined|null|\[object/);
      }
    }
  });

  it('gives each provider its own dialect rather than one shared string', () => {
    const veo = new VeoProvider().renderPrompt(spec);
    const kling = new KlingProvider().renderPrompt(spec);
    expect(veo).not.toBe(kling);
    // Veo leads with the camera clause, Kling with the subject action.
    expect(veo.startsWith(spec.shot_size)).toBe(true);
    expect(kling.startsWith(spec.action)).toBe(true);
  });

  it('includes dialogue only when the spec has it', () => {
    const withLine = new VeoProvider().renderPrompt(spec);
    expect(withLine).toContain('Dialogue');
    const silent = new VeoProvider().renderPrompt({ ...spec, dialogue: null });
    expect(silent).not.toContain('Dialogue');
  });
});

describe('capability declarations', () => {
  it('are internally consistent', () => {
    for (const p of [new VeoProvider(), new KlingProvider(), new RunwayProvider(), new MockProvider()]) {
      const c = p.capabilities();
      expect(c.maxDurationS).toBeGreaterThan(0);
      expect(c.resolutions.length).toBeGreaterThan(0);
      expect(c.maxReferenceImages).toBeGreaterThanOrEqual(0);
      // Last-frame interpolation without first-frame conditioning is incoherent.
      if (c.lastFrameConditioning) expect(c.firstFrameConditioning).toBe(true);
    }
  });

  it('declares Runway as single-reference and no last-frame, per docs/03', () => {
    const c = new RunwayProvider().capabilities();
    expect(c.maxReferenceImages).toBe(1);
    expect(c.lastFrameConditioning).toBe(false);
  });
});

describe('credential handling', () => {
  it('fails with an actionable message instead of calling out unauthenticated', async () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(
        new VeoProvider().generate(spec, { idempotencyKey: 'k', tier: 'draft' }),
      ).rejects.toThrow(ProviderConfigError);
      await expect(
        new VeoProvider().generate(spec, { idempotencyKey: 'k', tier: 'draft' }),
      ).rejects.toThrow(/--provider mock/);
    } finally {
      if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    }
  });
});

describe('MockProvider', () => {
  it('is idempotent on the key - a retry must not create a second job', async () => {
    const p = new MockProvider({ latencyMs: 0 });
    const a = await p.generate(spec, { idempotencyKey: 'same', tier: 'draft' });
    const b = await p.generate(spec, { idempotencyKey: 'same', tier: 'draft' });
    expect(a.ref).toBe(b.ref);
    expect((await p.poll(a)).state).toBe('succeeded');
  });

  it('reports running before the simulated latency elapses', async () => {
    const p = new MockProvider({ latencyMs: 10_000 });
    const h = await p.generate(spec, { idempotencyKey: 'slow', tier: 'draft' });
    expect((await p.poll(h)).state).toBe('running');
  });

  it('injects failures deterministically for a given seed', async () => {
    const run = async () => {
      const p = new MockProvider({ latencyMs: 0, failureRate: 0.5, seed: 42 });
      const out: string[] = [];
      for (let i = 0; i < 8; i++) {
        const h = await p.generate(spec, { idempotencyKey: `k${i}`, tier: 'draft' });
        out.push((await p.poll(h)).state);
      }
      return out;
    };
    expect(await run()).toEqual(await run());
  });

  it('fails closed on an unknown ref', async () => {
    const p = new MockProvider();
    const status = await p.poll({ providerId: 'mock', ref: 'nope', submittedAt: 0 });
    expect(status).toMatchObject({ state: 'failed', retryable: false });
  });
});
