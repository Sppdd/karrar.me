import type { Money, ShotSpec } from '@vidgen/shared';
import { estimateCost } from '../pricing.ts';
import { cameraClause, joinClauses, lookClause } from '../prompt.ts';
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
 * Kling 3.0.
 *
 * WIRE FORMAT IS UNVERIFIED - see the note in veo.ts. Kling authenticates with
 * a JWT signed from an access key / secret key pair; this adapter expects the
 * assembled token in KLING_API_TOKEN so token minting stays out of the
 * benchmark's latency measurements.
 *
 * Chosen for: the strongest multi-angle subject consistency of the current set,
 * which is the axis that matters most for the recurring-character requirement
 * (docs/03), at roughly half Veo's per-second cost.
 */
const BASE = 'https://api.klingai.com/v1';

export class KlingProvider implements VideoProvider {
  readonly id = 'kling';
  readonly model = 'kling-3.0';

  capabilities(): ProviderCapabilities {
    return {
      maxDurationS: 10,
      resolutions: ['720p', '1080p'],
      maxReferenceImages: 4,
      firstFrameConditioning: true,
      lastFrameConditioning: true,
      nativeAudio: false,
      aspectRatios: ['16:9', '9:16', '1:1'],
    };
  }

  estimate(spec: ShotSpec, tier: RenderTier): Money {
    return estimateCost({
      providerId: this.id,
      model: this.model,
      resolution: tier === 'draft' ? '720p' : '1080p',
      durationS: spec.duration_s,
    });
  }

  renderPrompt(spec: ShotSpec): string {
    // Kling takes subject-first phrasing better than camera-first.
    return joinClauses([spec.action, cameraClause(spec), lookClause(spec)]);
  }

  async generate(spec: ShotSpec, opts: GenerateOptions): Promise<JobHandle> {
    const token = requireEnv(this.id, 'KLING_API_TOKEN');
    const endpoint = opts.firstFrame ? 'videos/image2video' : 'videos/text2video';

    const res = await requestJson<KlingCreate>(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model_name: this.model,
        prompt: this.renderPrompt(spec),
        duration: String(spec.duration_s),
        mode: opts.tier === 'draft' ? 'std' : 'pro',
        external_task_id: opts.idempotencyKey,
        ...(opts.firstFrame ? { image: opts.firstFrame } : {}),
      }),
    });

    const ref = res.data?.task_id;
    if (!ref) throw new Error(`kling: no task_id in create response (code ${res.code})`);
    return { providerId: this.id, ref, submittedAt: Date.now() };
  }

  async poll(handle: JobHandle): Promise<JobStatus> {
    const token = requireEnv(this.id, 'KLING_API_TOKEN');
    const res = await requestJson<KlingQuery>(`${BASE}/videos/text2video/${handle.ref}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    switch (res.data?.task_status) {
      case 'submitted':
        return { state: 'pending' };
      case 'processing':
        return { state: 'running' };
      case 'succeed': {
        const url = res.data.task_result?.videos?.[0]?.url;
        return url
          ? { state: 'succeeded', clipUrl: url }
          : { state: 'failed', reason: 'succeed with no video url', retryable: false };
      }
      case 'failed':
        return {
          state: 'failed',
          reason: res.data.task_status_msg ?? 'unknown',
          retryable: false,
        };
      default:
        return { state: 'pending' };
    }
  }
}

interface KlingCreate {
  readonly code?: number;
  readonly data?: { readonly task_id?: string };
}

interface KlingQuery {
  readonly data?: {
    readonly task_status?: 'submitted' | 'processing' | 'succeed' | 'failed';
    readonly task_status_msg?: string;
    readonly task_result?: { readonly videos?: readonly { readonly url?: string }[] };
  };
}
