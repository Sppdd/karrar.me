import type { Money } from '@vidgen/shared';
import type { ShotSpec } from '@vidgen/shared';

export type RenderTier = 'draft' | 'final';

export type Resolution = '480p' | '720p' | '1080p' | '4k';

/**
 * Static declaration of what an adapter can accept. This is real logic, not
 * documentation: the planner reads it and degrades gracefully, so a provider
 * that cannot take a first-frame condition falls back to reference-image
 * conditioning instead of failing the workflow (docs/01, docs/03).
 */
export interface ProviderCapabilities {
  readonly maxDurationS: number;
  readonly resolutions: readonly Resolution[];
  /** How many character reference images the provider accepts. 0 = unsupported. */
  readonly maxReferenceImages: number;
  /** Supports conditioning on a first frame - the continuity-chaining path. */
  readonly firstFrameConditioning: boolean;
  /** Supports first AND last frame interpolation. */
  readonly lastFrameConditioning: boolean;
  readonly nativeAudio: boolean;
  readonly aspectRatios: readonly string[];
}

export interface GenerateOptions {
  readonly idempotencyKey: string;
  readonly tier: RenderTier;
  /** S3 keys or URLs of character reference images, subject to maxReferenceImages. */
  readonly referenceImages?: readonly string[];
  /** Last frame of the previous shot, for continuity chaining. */
  readonly firstFrame?: string;
}

export interface JobHandle {
  readonly providerId: string;
  readonly ref: string;
  readonly submittedAt: number;
}

export type JobStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'running'; readonly progress?: number }
  | { readonly state: 'succeeded'; readonly clipUrl: string; readonly billedCost?: Money }
  | { readonly state: 'failed'; readonly reason: string; readonly retryable: boolean };

/**
 * The one internal interface every video model sits behind. Pricing and quality
 * shift every quarter; without this layer each shift is a refactor (docs/01).
 */
export interface VideoProvider {
  readonly id: string;
  readonly model: string;

  capabilities(): ProviderCapabilities;

  /** Pre-flight cost from the pricing table. Never calls the provider. */
  estimate(spec: ShotSpec, tier: RenderTier): Money;

  /** Dispatch. Must be idempotent on opts.idempotencyKey - Temporal will retry. */
  generate(spec: ShotSpec, opts: GenerateOptions): Promise<JobHandle>;

  poll(handle: JobHandle): Promise<JobStatus>;

  /** Render the spec into this provider's prompt dialect. The only place
   *  provider-specific string building is allowed. */
  renderPrompt(spec: ShotSpec): string;
}

export class ProviderConfigError extends Error {
  constructor(providerId: string, message: string) {
    super(`[${providerId}] ${message}`);
    this.name = 'ProviderConfigError';
  }
}
