# Phasing

| Phase | Weeks | Ships |
| :-- | :-- | :-- |
| 0 | 1–2 | Provider spike: benchmark 3 video models on cost, latency, character fidelity. Pick two. |
| 1 | 3–6 | Google OAuth, brand profile, script → shot list, single-shot generation, credit ledger, FIB top-ups |
| 2 | 7–10 | Multi-shot assembly, continuity chaining, one character, export, ZainCash. **MVP launch.** |
| 3 | 11–16 | Character bible, style library, draft/final modes, reference-clip descriptors, Qi Card + phone auth |
| 4 | 17+ | Series continuity, team seats, platform-native aspect exports, analytics |

## Phase 0 is not optional

Your unit economics are determined entirely by two things: provider pricing, and
how many regenerations a user needs to get an acceptable shot. The first is
public. **The second you must measure**, and it is the one that decides whether
the business works.

Build the benchmark harness *first*, because it is also the provider adapter
layer — Phase 0 is not throwaway work:

- A fixed set of ~20 shot specs covering the range you expect: dialogue, action,
  product hero, establishing, character close-up.
- Adapters for every candidate model behind the `VideoProvider` interface from
  [01-architecture.md](01-architecture.md#provider-adapter-layer).
- Per attempt, record: provider, model, resolution, wall-clock latency, actual
  billed cost, and a human fidelity score (does the character look like the
  character?).

Two outputs:

1. **The seed data for `pricing_table`** — real measured costs, not blog-post
   estimates.
2. **A baseline regeneration rate.** If it takes four attempts to get an
   acceptable character close-up, you know that before you have built a product
   around the assumption that it takes one.

Pick two providers, not one. One is a single point of failure on both
availability and pricing; three is more adapter surface than a pre-MVP team can
maintain.

## Sequencing rationale

Phase 1 ends at **single-shot** generation with a working ledger. That is
deliberate: it proves the money path and the provider path independently before
either is entangled with assembly.

Phase 2 adds assembly and continuity, which is where the product becomes
demonstrably different from a prompt box, and launches. One character, one style
preset — resisting the urge to broaden here is the whole discipline of the plan.

Phase 3 is where the layers go on. Every item in it is genuinely optional for a
first paying user, which is exactly why it comes after launch feedback rather
than before.
