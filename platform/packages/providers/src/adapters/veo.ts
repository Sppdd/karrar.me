import type { Money, ShotSpec } from '@vidgen/shared';
import { estimateCost } from '../pricing.ts';
import { cameraClause, dialogueClause, joinClauses, lookClause } from '../prompt.ts';
import type {
  GenerateOptions,
  JobHandle,
  JobStatus,
  ProviderCapabilities,
  RenderTier,
  VideoProvider,
} from '../types.ts';
import { requestJson, requireEnv } from './http.ts';

/**
 * Google Veo 3.1 via the Gemini API.
 *
 * WIRE FORMAT IS UNVERIFIED. The request/response mapping below is written to
 * the documented shape of the Gemini long-running video operations API, but has
 * not been run against a live key. Confirming it is literally the first task of
 * Phase 0 - see apps/bench/README.md. Everything outside `#toRequest` and
 * `#fromOperation` is provider-agnostic and already exercised by the mock tests.
 *
 * Chosen for: native audio, 4K, and first/last-frame interpolation, which makes
 * continuity chaining (docs/03) a first-class call rather than a workaround.
 */
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface VeoOptions {
  /** 'veo-3.1' | 'veo-3.1-fast' | 'veo-3.1-light' */
  readonly model?: string;
  readonly aspectRatio?: string;
}

export class VeoProvider implements VideoProvider {
  readonly id = 'veo';
  readonly model: string;
  readonly #aspectRatio: string;

  constructor(opts: VeoOptions = {}) {
    this.model = opts.model ?? 'veo-3.1-fast';
    this.#aspectRatio = opts.aspectRatio ?? '9:16';
  }

  capabilities(): ProviderCapabilities {
    return {
      maxDurationS: 8,
      resolutions: ['720p', '1080p', '4k'],
      // Documented as accepting a small number of reference images ("ingredients
      // to video"). Sources disagree between 3 and 4; Phase 0 pins it.
      maxReferenceImages: 3,
      firstFrameConditioning: true,
      lastFrameConditioning: true,
      nativeAudio: true,
      aspectRatios: ['16:9', '9:16'],
    };
  }

  estimate(spec: ShotSpec, tier: RenderTier): Money {
    return estimateCost({
      providerId: this.id,
      model: tier === 'draft' ? 'veo-3.1-light' : this.model,
      resolution: tier === 'draft' ? '720p' : '1080p',
      durationS: spec.duration_s,
    });
  }

  renderPrompt(spec: ShotSpec): string {
    // Veo responds well to a single cinematic sentence with the camera
    // instruction leading, then subject action, then look.
    return joinClauses([
      cameraClause(spec),
      spec.action,
      lookClause(spec),
      dialogueClause(spec),
      `Style: ${spec.style_preset}`,
    ]);
  }

  async generate(spec: ShotSpec, opts: GenerateOptions): Promise<JobHandle> {
    const key = requireEnv(this.id, 'GEMINI_API_KEY');
    const model = opts.tier === 'draft' ? 'veo-3.1-light' : this.model;
    const body = this.#toRequest(spec, opts);

    const res = await requestJson<{ name: string }>(
      `${BASE}/models/${model}:predictLongRunning`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': key,
          // Not all providers honour this; sending it costs nothing and is the
          // difference between a retry and a double charge where they do.
          'x-idempotency-key': opts.idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    );
    return { providerId: this.id, ref: res.name, submittedAt: Date.now() };
  }

  async poll(handle: JobHandle): Promise<JobStatus> {
    const key = requireEnv(this.id, 'GEMINI_API_KEY');
    const op = await requestJson<VeoOperation>(`${BASE}/${handle.ref}`, {
      headers: { 'x-goog-api-key': key },
    });
    return this.#fromOperation(op);
  }

  // --- provider-specific mapping; verify against live docs in Phase 0 --------

  #toRequest(spec: ShotSpec, opts: GenerateOptions): unknown {
    const refs = (opts.referenceImages ?? []).slice(0, this.capabilities().maxReferenceImages);
    return {
      instances: [
        {
          prompt: this.renderPrompt(spec),
          ...(opts.firstFrame ? { image: { gcsUri: opts.firstFrame } } : {}),
          ...(refs.length ? { referenceImages: refs.map((uri) => ({ gcsUri: uri })) } : {}),
        },
      ],
      parameters: {
        aspectRatio: this.#aspectRatio,
        durationSeconds: spec.duration_s,
        resolution: opts.tier === 'draft' ? '720p' : '1080p',
      },
    };
  }

  #fromOperation(op: VeoOperation): JobStatus {
    if (op.error) {
      return { state: 'failed', reason: op.error.message, retryable: false };
    }
    if (!op.done) return { state: 'running' };
    const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    return uri
      ? { state: 'succeeded', clipUrl: uri }
      : { state: 'failed', reason: 'operation done with no video URI', retryable: false };
  }
}

interface VeoOperation {
  readonly done?: boolean;
  readonly error?: { readonly message: string };
  readonly response?: {
    readonly generateVideoResponse?: {
      readonly generatedSamples?: readonly { readonly video?: { readonly uri?: string } }[];
    };
  };
}
