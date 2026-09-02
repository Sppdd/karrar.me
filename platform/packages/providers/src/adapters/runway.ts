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
 * Runway Gen-4 / Gen-4.5.
 *
 * WIRE FORMAT IS UNVERIFIED - see the note in veo.ts.
 *
 * Chosen for: the cheapest credible draft tier in the set (Gen-4 Turbo), which
 * makes it the natural draft-mode router target, plus single-reference
 * character consistency with no fine-tuning.
 *
 * Note Runway's image_to_video path requires a first frame, so text-only shots
 * route to Gen-4.5's text path; the capability declaration reflects that.
 */
const BASE = 'https://api.dev.runwayml.com/v1';
const API_VERSION = '2024-11-06';

export class RunwayProvider implements VideoProvider {
  readonly id = 'runway';
  readonly model: string;

  constructor(model = 'gen-4.5') {
    this.model = model;
  }

  capabilities(): ProviderCapabilities {
    return {
      maxDurationS: 10,
      resolutions: ['720p', '1080p'],
      maxReferenceImages: 1,
      firstFrameConditioning: true,
      lastFrameConditioning: false,
      nativeAudio: false,
      aspectRatios: ['16:9', '9:16'],
    };
  }

  estimate(spec: ShotSpec, tier: RenderTier): Money {
    return tier === 'draft'
      ? estimateCost({
          providerId: this.id,
          model: 'gen-4-turbo',
          resolution: '720p',
          durationS: spec.duration_s,
        })
      : estimateCost({
          providerId: this.id,
          model: 'gen-4.5',
          resolution: '1080p',
          durationS: spec.duration_s,
        });
  }

  renderPrompt(spec: ShotSpec): string {
    return joinClauses([spec.action, cameraClause(spec), lookClause(spec)]);
  }

  async generate(spec: ShotSpec, opts: GenerateOptions): Promise<JobHandle> {
    const key = requireEnv(this.id, 'RUNWAY_API_KEY');
    const res = await requestJson<{ id: string }>(`${BASE}/image_to_video`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-runway-version': API_VERSION,
      },
      body: JSON.stringify({
        model: opts.tier === 'draft' ? 'gen4_turbo' : 'gen4.5',
        promptText: this.renderPrompt(spec),
        duration: spec.duration_s,
        ratio: '720:1280',
        ...(opts.firstFrame ? { promptImage: opts.firstFrame } : {}),
      }),
    });
    return { providerId: this.id, ref: res.id, submittedAt: Date.now() };
  }

  async poll(handle: JobHandle): Promise<JobStatus> {
    const key = requireEnv(this.id, 'RUNWAY_API_KEY');
    const res = await requestJson<RunwayTask>(`${BASE}/tasks/${handle.ref}`, {
      headers: { authorization: `Bearer ${key}`, 'x-runway-version': API_VERSION },
    });

    switch (res.status) {
      case 'PENDING':
        return { state: 'pending' };
      case 'RUNNING':
        return { state: 'running', ...(res.progress !== undefined && { progress: res.progress }) };
      case 'SUCCEEDED': {
        const url = res.output?.[0];
        return url
          ? { state: 'succeeded', clipUrl: url }
          : { state: 'failed', reason: 'SUCCEEDED with empty output', retryable: false };
      }
      default:
        return { state: 'failed', reason: res.failure ?? 'unknown', retryable: false };
    }
  }
}

interface RunwayTask {
  readonly status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  readonly progress?: number;
  readonly output?: readonly string[];
  readonly failure?: string;
}
