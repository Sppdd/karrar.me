import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../../apps/bench/src/fixtures.ts';
import { SPEC_VERSION, parseShotSpec, shotSpecCacheKey, shotSpecJsonSchema } from '../src/shot-spec.ts';

const valid = {
  spec_version: SPEC_VERSION,
  shot_id: 's3',
  duration_s: 4,
  shot_size: 'medium close-up',
  lens_mm: 50,
  camera_move: 'slow push-in',
  angle: 'slightly low',
  lighting: 'hard key, practical neon fill',
  palette: ['#1a2b4c', '#ff6b35'],
  mood: 'tense anticipation',
  characters: ['char_amina'],
  action: 'she sets the cup down and looks off-frame',
  dialogue: null,
  style_preset: 'kdrama_night_warm',
  continuity_from: 's2',
};

describe('shotSpecSchema', () => {
  it('accepts the canonical spec from docs/02', () => {
    expect(parseShotSpec(valid).shot_id).toBe('s3');
  });

  it('rejects unknown fields rather than silently dropping them', () => {
    expect(() => parseShotSpec({ ...valid, prompt: 'a cat' })).toThrow();
  });

  it('constrains the camera vocabulary', () => {
    expect(() => parseShotSpec({ ...valid, camera_move: 'zoom whoosh' })).toThrow();
    expect(() => parseShotSpec({ ...valid, shot_size: 'medium-ish' })).toThrow();
  });

  it('requires #rrggbb palette entries', () => {
    expect(() => parseShotSpec({ ...valid, palette: ['red'] })).toThrow();
    expect(() => parseShotSpec({ ...valid, palette: ['#fff'] })).toThrow();
  });

  it('rejects a mismatched spec_version so old specs cannot silently render', () => {
    expect(() => parseShotSpec({ ...valid, spec_version: 99 })).toThrow();
  });

  it('emits a JSON Schema for LLM structured output', () => {
    const schema = shotSpecJsonSchema();
    expect(schema).toHaveProperty('properties.camera_move');
    expect(JSON.stringify(schema)).toContain('slow push-in');
  });

  it('every benchmark fixture is a valid spec', () => {
    expect(FIXTURES).toHaveLength(20);
    for (const f of FIXTURES) expect(() => parseShotSpec(f.spec)).not.toThrow();
  });
});

describe('shotSpecCacheKey', () => {
  it('ignores position so identical content hits the cache', () => {
    const a = parseShotSpec({ ...valid, shot_id: 's3', continuity_from: 's2' });
    const b = parseShotSpec({ ...valid, shot_id: 's9', continuity_from: null });
    expect(shotSpecCacheKey(a)).toBe(shotSpecCacheKey(b));
  });

  it('separates specs that render differently', () => {
    const a = parseShotSpec(valid);
    const b = parseShotSpec({ ...valid, lens_mm: 85 });
    expect(shotSpecCacheKey(a)).not.toBe(shotSpecCacheKey(b));
  });
});
