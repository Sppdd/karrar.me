import { MockProvider } from './adapters/mock.ts';
import { KlingProvider } from './adapters/kling.ts';
import { RunwayProvider } from './adapters/runway.ts';
import { VeoProvider } from './adapters/veo.ts';
import type { VideoProvider } from './types.ts';

export const registry = {
  mock: () => new MockProvider(),
  veo: () => new VeoProvider(),
  kling: () => new KlingProvider(),
  runway: () => new RunwayProvider(),
} as const satisfies Record<string, () => VideoProvider>;

export type ProviderId = keyof typeof registry;

export const isProviderId = (v: string): v is ProviderId => v in registry;

export function createProvider(id: string): VideoProvider {
  if (!isProviderId(id)) {
    throw new Error(`unknown provider "${id}". Known: ${Object.keys(registry).join(', ')}`);
  }
  return registry[id]();
}
