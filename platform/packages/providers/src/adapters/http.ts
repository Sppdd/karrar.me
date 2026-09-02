import { ProviderConfigError } from '../types.ts';

export function requireEnv(providerId: string, name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new ProviderConfigError(
      providerId,
      `missing ${name}. Copy .env.example to .env and set it, or run with --provider mock.`,
    );
  }
  return v;
}

export interface HttpError extends Error {
  status: number;
  body: string;
  retryable: boolean;
}

/**
 * Thin fetch wrapper. Deliberately no retry logic: retries are Temporal's job
 * in the platform and the benchmark runner's job here, and burying them at this
 * level makes latency measurements meaningless.
 */
export async function requestJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 60_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 400)}`) as HttpError;
    err.status = res.status;
    err.body = body;
    // 408/429 and 5xx are worth another attempt; 4xx generally is not.
    err.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    throw err;
  }
  return (await res.json()) as T;
}

export const isRetryable = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'retryable' in e
    ? Boolean((e as HttpError).retryable)
    : e instanceof DOMException && e.name === 'TimeoutError';
