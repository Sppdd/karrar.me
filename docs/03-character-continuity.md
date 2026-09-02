# Character consistency

Three mechanisms, layered. Each is cheap on its own; together they are the
difference between "AI slop" and something a brand will actually run.

## 1. Character bible

A record per character: canonical description, wardrobe, age, and **3–5 locked
reference images**. Locked means locked — regenerating the reference set
invalidates every downstream shot's consistency, so treat a change as a new
character version.

## 2. Reference conditioning

Pass reference images into providers that support character references.

The practical constraint is that reference-image budgets are small — current
models take roughly three images, not a gallery. So the useful unit is a
`character_ref_set` per character **per style**: the same character rendered in
the style you are about to shoot in, from which the adapter selects the best
three for the shot. A reference set shot in daylight realism will fight a
`kdrama_night_warm` preset.

Of the current model set, Kling's multi-angle subject consistency is the
strongest for character-driven work, which is a reason to keep it in the routing
table even if it does not win on other axes.

## 3. Continuity chaining

Feed the **last frame of shot N as the first-frame condition of shot N+1**
whenever the cut is continuous.

This is the cheapest and most effective trick available, and it is a first-class
API feature rather than a hack — Veo 3.1 exposes first/last-frame interpolation
directly, so a continuous cut is a supported call, not a workaround.

The `continuity_from` field on the shot spec drives it. When set, the assembly
workflow extracts the final frame of the referenced shot's chosen take and
passes it as the conditioning image. When null, the shot generates independently
— which is what you want across a hard cut, where forcing continuity produces a
weird morph instead of an edit.

Note the dependency this creates: chained shots cannot be generated in parallel.
The planner should identify chain segments and fan out *across* segments while
running each segment serially.

## Series-level continuity

A `series` entity holds characters, locations, and palette, so episode 7 matches
episode 1. Projects belong to a series and inherit its bindings; a project can
override, but the override is explicit and visible.

This is Phase 4 work. Design the foreign keys for it in Phase 1 so you are not
migrating later.
