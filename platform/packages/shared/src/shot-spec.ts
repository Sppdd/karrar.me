import { z } from 'zod';

/**
 * The shot spec. See docs/02-shot-spec.md.
 *
 * Users never write prompts; the LLM emits this object and each provider
 * adapter renders it into that provider's prompt dialect. Bump SPEC_VERSION on
 * any breaking change - stored specs from earlier versions must still render.
 */
export const SPEC_VERSION = 1;

/**
 * Constrained vocabularies. These are enums rather than free text because a
 * fixed vocabulary is what lets an adapter render reliably into a provider
 * dialect, and what lets the UI offer a dropdown instead of a prompt box.
 * `action` and `mood` stay free text - that is where the creative signal is.
 */
export const SHOT_SIZES = [
  'extreme wide',
  'wide',
  'medium wide',
  'medium',
  'medium close-up',
  'close-up',
  'extreme close-up',
] as const;

export const CAMERA_MOVES = [
  'static',
  'slow push-in',
  'slow pull-out',
  'pan left',
  'pan right',
  'tilt up',
  'tilt down',
  'tracking',
  'handheld',
  'crane up',
  'orbit',
] as const;

export const CAMERA_ANGLES = [
  'eye level',
  'slightly low',
  'low',
  'slightly high',
  'high',
  'overhead',
  'dutch',
] as const;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

export const shotSpecSchema = z
  .object({
    spec_version: z.literal(SPEC_VERSION),
    shot_id: z.string().min(1),
    duration_s: z.number().int().min(1).max(20),
    shot_size: z.enum(SHOT_SIZES),
    lens_mm: z.number().int().min(8).max(300),
    camera_move: z.enum(CAMERA_MOVES),
    angle: z.enum(CAMERA_ANGLES),
    lighting: z.string().min(1),
    palette: z.array(hexColor).min(1).max(6),
    mood: z.string().min(1),
    characters: z.array(z.string()),
    action: z.string().min(1),
    dialogue: z.string().nullable(),
    style_preset: z.string().min(1),
    /** shot_id of the preceding shot when the cut is continuous, else null. */
    continuity_from: z.string().nullable(),
  })
  .strict();

export type ShotSpec = z.infer<typeof shotSpecSchema>;

export const parseShotSpec = (input: unknown): ShotSpec => shotSpecSchema.parse(input);

/**
 * JSON Schema for LLM structured output, so the model is constrained to emit a
 * valid spec rather than asked nicely to. Derived from the same zod definition
 * the API validates against - one source of truth, per docs/02.
 */
export const shotSpecJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(shotSpecSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;

/**
 * Stable identity of a spec's *renderable* content, for the shot-spec cache in
 * docs/04. Deliberately excludes shot_id and continuity_from: two shots with
 * identical content render identically regardless of where they sit in a
 * timeline, and that is exactly the cache hit worth having.
 */
export function shotSpecCacheKey(spec: ShotSpec): string {
  const { shot_id: _id, continuity_from: _from, ...rest } = spec;
  return JSON.stringify(rest, Object.keys(rest).sort());
}
