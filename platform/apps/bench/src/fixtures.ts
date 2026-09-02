import { SPEC_VERSION, type ShotSpec, parseShotSpec } from '@vidgen/shared';

/**
 * The fixed benchmark set (docs/05).
 *
 * Five categories, four specs each. The categories are chosen because they
 * stress different provider weaknesses: dialogue exposes lip-sync and audio,
 * action exposes temporal coherence, product-hero exposes text and material
 * rendering, establishing exposes scale and background stability, and
 * character-closeup exposes the identity consistency the whole product depends on.
 *
 * Keep this set FROZEN once Phase 0 starts. Comparability across providers and
 * across time is the entire value; a fixture edited midway invalidates the
 * regeneration-rate baseline it fed.
 */
export type Category =
  | 'dialogue'
  | 'action'
  | 'product-hero'
  | 'establishing'
  | 'character-closeup';

export interface Fixture {
  readonly id: string;
  readonly category: Category;
  readonly spec: ShotSpec;
}

const base = {
  spec_version: SPEC_VERSION,
  characters: [] as string[],
  dialogue: null,
  continuity_from: null,
} as const;

const raw: readonly (Omit<Fixture, 'spec'> & { spec: unknown })[] = [
  // --- dialogue ----------------------------------------------------------
  {
    id: 'dlg-01',
    category: 'dialogue',
    spec: {
      ...base, shot_id: 'dlg-01', duration_s: 5, shot_size: 'medium close-up', lens_mm: 50,
      camera_move: 'static', angle: 'eye level',
      lighting: 'soft key from window left, gentle fill',
      palette: ['#e8dcc8', '#3a4a5c'], mood: 'candid warmth',
      characters: ['char_amina'],
      action: 'she looks directly at camera and speaks, then breaks into a small smile',
      dialogue: 'I did not think it would work either.',
      style_preset: 'doc_natural_day',
    },
  },
  {
    id: 'dlg-02',
    category: 'dialogue',
    spec: {
      ...base, shot_id: 'dlg-02', duration_s: 4, shot_size: 'close-up', lens_mm: 85,
      camera_move: 'slow push-in', angle: 'slightly low',
      lighting: 'hard key, practical neon fill',
      palette: ['#1a2b4c', '#ff6b35'], mood: 'tense anticipation',
      characters: ['char_amina'],
      action: 'he pauses mid-sentence and glances off-frame',
      dialogue: 'You are sure nobody else knows?',
      style_preset: 'kdrama_night_warm',
    },
  },
  {
    id: 'dlg-03',
    category: 'dialogue',
    spec: {
      ...base, shot_id: 'dlg-03', duration_s: 6, shot_size: 'medium', lens_mm: 35,
      camera_move: 'handheld', angle: 'eye level',
      lighting: 'overcast daylight, flat',
      palette: ['#9aa7ad', '#d6cfc4'], mood: 'restless',
      characters: ['char_amina'],
      action: 'she walks and talks over her shoulder, weaving through a crowd',
      dialogue: 'Keep up, we have four minutes.',
      style_preset: 'doc_natural_day',
    },
  },
  {
    id: 'dlg-04',
    category: 'dialogue',
    spec: {
      ...base, shot_id: 'dlg-04', duration_s: 4, shot_size: 'medium close-up', lens_mm: 50,
      camera_move: 'static', angle: 'slightly high',
      lighting: 'single overhead source, deep shadow under eyes',
      palette: ['#12100e', '#c9a227'], mood: 'confession',
      characters: ['char_amina'],
      action: 'he speaks quietly, barely moving',
      dialogue: 'It was me.',
      style_preset: 'noir_interior',
    },
  },

  // --- action ------------------------------------------------------------
  {
    id: 'act-01',
    category: 'action',
    spec: {
      ...base, shot_id: 'act-01', duration_s: 4, shot_size: 'wide', lens_mm: 24,
      camera_move: 'tracking', angle: 'low',
      lighting: 'low sun raking across wet asphalt',
      palette: ['#2b3a42', '#f5a623'], mood: 'urgent',
      action: 'a runner sprints past camera left to right, spray kicking up behind',
      style_preset: 'gritty_urban',
    },
  },
  {
    id: 'act-02',
    category: 'action',
    spec: {
      ...base, shot_id: 'act-02', duration_s: 3, shot_size: 'medium', lens_mm: 35,
      camera_move: 'handheld', angle: 'eye level',
      lighting: 'flickering firelight, high contrast',
      palette: ['#1b0f0a', '#ff7a18'], mood: 'chaotic',
      action: 'hands frantically pack a bag, objects tumbling',
      style_preset: 'gritty_urban',
    },
  },
  {
    id: 'act-03',
    category: 'action',
    spec: {
      ...base, shot_id: 'act-03', duration_s: 5, shot_size: 'medium wide', lens_mm: 28,
      camera_move: 'orbit', angle: 'eye level',
      lighting: 'harsh midday sun, hard shadows',
      palette: ['#c2b280', '#4a90d9'], mood: 'standoff',
      action: 'two figures circle each other slowly on open ground',
      style_preset: 'gritty_urban',
    },
  },
  {
    id: 'act-04',
    category: 'action',
    spec: {
      ...base, shot_id: 'act-04', duration_s: 3, shot_size: 'close-up', lens_mm: 85,
      camera_move: 'crane up', angle: 'high',
      lighting: 'cold blue rim, dark surround',
      palette: ['#0d1b2a', '#e0e1dd'], mood: 'release',
      action: 'a hand opens and releases a fistful of sand into the wind',
      style_preset: 'noir_interior',
    },
  },

  // --- product hero ------------------------------------------------------
  {
    id: 'prd-01',
    category: 'product-hero',
    spec: {
      ...base, shot_id: 'prd-01', duration_s: 4, shot_size: 'extreme close-up', lens_mm: 100,
      camera_move: 'slow push-in', angle: 'slightly low',
      lighting: 'controlled softbox, single specular highlight',
      palette: ['#ffffff', '#111111'], mood: 'precise',
      action: 'condensation beads slide down a matte glass bottle',
      style_preset: 'studio_product_clean',
    },
  },
  {
    id: 'prd-02',
    category: 'product-hero',
    spec: {
      ...base, shot_id: 'prd-02', duration_s: 3, shot_size: 'medium', lens_mm: 50,
      camera_move: 'orbit', angle: 'eye level',
      lighting: 'gradient background sweep, rim light both sides',
      palette: ['#f2f2f2', '#2d6a4f'], mood: 'confident',
      action: 'a pair of running shoes rotates on a seamless backdrop',
      style_preset: 'studio_product_clean',
    },
  },
  {
    id: 'prd-03',
    category: 'product-hero',
    spec: {
      ...base, shot_id: 'prd-03', duration_s: 4, shot_size: 'close-up', lens_mm: 85,
      camera_move: 'tilt up', angle: 'slightly low',
      lighting: 'warm practical lamp, shallow falloff',
      palette: ['#3e2723', '#d7ccc8'], mood: 'crafted',
      action: 'steam rises from a ceramic cup as a hand sets it down',
      style_preset: 'studio_product_clean',
    },
  },
  {
    id: 'prd-04',
    category: 'product-hero',
    spec: {
      ...base, shot_id: 'prd-04', duration_s: 3, shot_size: 'extreme close-up', lens_mm: 100,
      camera_move: 'static', angle: 'overhead',
      lighting: 'even diffuse, no visible shadow',
      palette: ['#fafafa', '#1565c0'], mood: 'clinical',
      action: 'a phone screen wakes and a notification slides in',
      style_preset: 'studio_product_clean',
    },
  },

  // --- establishing ------------------------------------------------------
  {
    id: 'est-01',
    category: 'establishing',
    spec: {
      ...base, shot_id: 'est-01', duration_s: 6, shot_size: 'extreme wide', lens_mm: 16,
      camera_move: 'slow push-in', angle: 'high',
      lighting: 'blue hour, city lights coming on',
      palette: ['#16324f', '#f0a202'], mood: 'anticipation',
      action: 'a city skyline at dusk, traffic threading below',
      style_preset: 'kdrama_night_warm',
    },
  },
  {
    id: 'est-02',
    category: 'establishing',
    spec: {
      ...base, shot_id: 'est-02', duration_s: 5, shot_size: 'wide', lens_mm: 24,
      camera_move: 'pan right', angle: 'eye level',
      lighting: 'golden hour backlight, long shadows',
      palette: ['#d99058', '#5c4033'], mood: 'quiet',
      action: 'an empty market street, awnings shifting in the wind',
      style_preset: 'doc_natural_day',
    },
  },
  {
    id: 'est-03',
    category: 'establishing',
    spec: {
      ...base, shot_id: 'est-03', duration_s: 6, shot_size: 'extreme wide', lens_mm: 16,
      camera_move: 'crane up', angle: 'low',
      lighting: 'overcast, flat and cool',
      palette: ['#8d99ae', '#edf2f4'], mood: 'isolation',
      action: 'a single road cuts across open desert toward distant hills',
      style_preset: 'doc_natural_day',
    },
  },
  {
    id: 'est-04',
    category: 'establishing',
    spec: {
      ...base, shot_id: 'est-04', duration_s: 5, shot_size: 'wide', lens_mm: 28,
      camera_move: 'static', angle: 'eye level',
      lighting: 'harsh sodium streetlight, deep shadow',
      palette: ['#0b1120', '#ffb703'], mood: 'waiting',
      action: 'rain falls through a streetlight cone over an empty junction',
      style_preset: 'noir_interior',
    },
  },

  // --- character closeup -------------------------------------------------
  {
    id: 'chr-01',
    category: 'character-closeup',
    spec: {
      ...base, shot_id: 'chr-01', duration_s: 4, shot_size: 'close-up', lens_mm: 85,
      camera_move: 'static', angle: 'eye level',
      lighting: 'soft key, subtle rim separation',
      palette: ['#e8dcc8', '#3a4a5c'], mood: 'considering',
      characters: ['char_amina'],
      action: 'she holds still, eyes moving as she thinks',
      style_preset: 'doc_natural_day',
    },
  },
  {
    id: 'chr-02',
    category: 'character-closeup',
    spec: {
      ...base, shot_id: 'chr-02', duration_s: 4, shot_size: 'medium close-up', lens_mm: 50,
      camera_move: 'slow push-in', angle: 'slightly low',
      lighting: 'hard key, practical neon fill',
      palette: ['#1a2b4c', '#ff6b35'], mood: 'resolve',
      characters: ['char_amina'],
      action: 'she sets the cup down and looks off-frame',
      style_preset: 'kdrama_night_warm',
    },
  },
  {
    id: 'chr-03',
    category: 'character-closeup',
    spec: {
      ...base, shot_id: 'chr-03', duration_s: 5, shot_size: 'close-up', lens_mm: 85,
      camera_move: 'handheld', angle: 'slightly high',
      lighting: 'window light, heavy falloff to shadow',
      palette: ['#2f3e46', '#cad2c5'], mood: 'grief',
      characters: ['char_amina'],
      action: 'she turns toward the light and closes her eyes',
      style_preset: 'noir_interior',
    },
  },
  {
    id: 'chr-04',
    category: 'character-closeup',
    spec: {
      ...base, shot_id: 'chr-04', duration_s: 3, shot_size: 'extreme close-up', lens_mm: 100,
      camera_move: 'static', angle: 'eye level',
      lighting: 'single hard source, strong contrast',
      palette: ['#12100e', '#c9a227'], mood: 'defiance',
      characters: ['char_amina'],
      action: 'her eyes open and fix on something off-frame',
      style_preset: 'noir_interior',
    },
  },
];

export const FIXTURES: readonly Fixture[] = raw.map((f) => ({
  id: f.id,
  category: f.category,
  spec: parseShotSpec(f.spec),
}));

export const CATEGORIES = [
  'dialogue',
  'action',
  'product-hero',
  'establishing',
  'character-closeup',
] as const satisfies readonly Category[];

export const fixturesFor = (categories?: readonly Category[]): readonly Fixture[] =>
  categories?.length ? FIXTURES.filter((f) => categories.includes(f.category)) : FIXTURES;
