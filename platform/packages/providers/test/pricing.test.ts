import { describe, expect, it } from 'vitest';
import { format } from '@vidgen/shared';
import { PRICING_TABLE, estimateCost, lookupPrice } from '../src/pricing.ts';
import { createProvider, registry } from '../src/registry.ts';

describe('pricing table', () => {
  it('prices a 4s Veo fast shot at the tabled per-second rate', () => {
    const cost = estimateCost({
      providerId: 'veo', model: 'veo-3.1-fast', resolution: '1080p', durationS: 4,
    });
    expect(format(cost)).toBe('USD 0.6000'); // 0.15/s * 4
  });

  it('is explicit about missing rows rather than defaulting to zero', () => {
    expect(() =>
      estimateCost({ providerId: 'veo', model: 'veo-9', resolution: '4k', durationS: 4 }),
    ).toThrow(/no pricing row/);
  });

  it('rejects nonsense durations', () => {
    const q = { providerId: 'kling', model: 'kling-3.0', resolution: '1080p' } as const;
    expect(() => estimateCost({ ...q, durationS: 0 })).toThrow(RangeError);
    expect(() => estimateCost({ ...q, durationS: 2.5 })).toThrow(RangeError);
  });

  it('honours effective dates so historical estimates reproduce', () => {
    const before = lookupPrice({
      providerId: 'kling', model: 'kling-3.0', resolution: '1080p', asOf: '2026-08-31',
    });
    const after = lookupPrice({
      providerId: 'kling', model: 'kling-3.0', resolution: '1080p', asOf: '2026-09-02',
    });
    expect(before).toBeUndefined();
    expect(after?.perSecond.micros).toBe(100_000n);
  });

  it('carries provenance, so estimates are never mistaken for invoices', () => {
    expect(PRICING_TABLE.every((r) => r.source === 'estimate')).toBe(true);
  });
});

describe('registry', () => {
  it('constructs every registered provider', () => {
    for (const id of Object.keys(registry)) {
      expect(createProvider(id).id).toBe(id);
    }
  });

  it('names the known providers when given a bad id', () => {
    expect(() => createProvider('sora')).toThrow(/unknown provider "sora".*mock/s);
  });
});
