import type { ShotSpec } from '@vidgen/shared';

/**
 * Shared prompt-rendering helpers. Adapters compose these into their own
 * dialect - they are building blocks, not a universal renderer, because the
 * whole point of the adapter layer is that each provider phrases things
 * differently.
 */

export const cameraClause = (spec: ShotSpec): string =>
  `${spec.shot_size}, ${spec.lens_mm}mm lens, ${spec.angle} angle, ${spec.camera_move}`;

export const lookClause = (spec: ShotSpec): string =>
  `${spec.lighting}. Color palette ${spec.palette.join(', ')}. Mood: ${spec.mood}`;

export function dialogueClause(spec: ShotSpec): string | undefined {
  return spec.dialogue ? `Dialogue: "${spec.dialogue}"` : undefined;
}

export const joinClauses = (parts: readonly (string | undefined)[]): string =>
  parts.filter((p): p is string => Boolean(p && p.trim())).join('. ').replace(/\.\.+/g, '.');
