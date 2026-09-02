# The shot spec

This is the moat. Everything else is commodity plumbing.

**Users do not write prompts.** The AI emits a structured object; adapters
render prompts from it. A prompt box is a feature any weekend project can copy.
A structured, editable, diffable shot spec is a product.

## The object

```json
{
  "spec_version": 1,
  "shot_id": "s3",
  "duration_s": 4,
  "shot_size": "medium close-up",
  "lens_mm": 50,
  "camera_move": "slow push-in",
  "angle": "slightly low",
  "lighting": "hard key, practical neon fill",
  "palette": ["#1a2b4c", "#ff6b35"],
  "mood": "tense anticipation",
  "characters": ["char_amina"],
  "action": "she sets the cup down and looks off-frame",
  "dialogue": null,
  "style_preset": "kdrama_night_warm",
  "continuity_from": "s2"
}
```

## Why this shape wins

**It is editable at the field level.** The user changes `camera_move` from
`"slow push-in"` to `"static"` and regenerates one shot. Compare that to asking
someone to rewrite a paragraph of prose prompt and hope the model changed only
the thing they meant.

**It is diffable.** You can show the user exactly what changed between attempt 1
and attempt 2, and you can store attempts cheaply.

**It is per-shot re-renderable.** Fixing shot 3 does not regenerate shots 1–6.
This is the single largest lever on regeneration cost, which is the number most
likely to sink the business — see [00-overview.md](00-overview.md#the-two-things-most-likely-to-sink-this).

**It routes across providers.** The same spec renders to Veo, Kling, or Runway
dialects. Users are not locked into whichever model you launched with.

## Implementation

Define it **once**, as a zod schema in `packages/shared`. From that single
definition derive:

1. TypeScript types for the API and the Next.js client.
2. The JSON Schema handed to the LLM for structured output, so the model is
   constrained to emit a valid spec rather than asked nicely to.
3. Runtime validation at the API boundary.

Version it with `spec_version` from day one. You will change this schema, and
stored specs from last month must still render.

Constrain the vocabulary. `shot_size`, `camera_move`, and `angle` are enums, not
free text — a fixed vocabulary is what lets you render reliably into each
provider's dialect and lets the UI offer a dropdown instead of a text field.
`action` and `mood` stay free text; that is where the creative signal lives.

## Style presets

Store as **versioned rows**: a bundle of lighting, lens, grade, and pacing
defaults. Authored in-house, not scraped. A shot spec references a preset by ID
and version, so a preset revision does not silently mutate finished projects.

A preset supplies defaults; explicit fields on the shot spec override them. The
renderer resolves preset → spec → provider dialect in that order.
