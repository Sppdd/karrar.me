import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AttemptRecord } from './types.ts';

/**
 * JSONL, append-only. Chosen over SQLite because a benchmark run that dies
 * halfway must not lose the attempts it already paid for, and because the
 * results file wants to be diffable and committable alongside the report.
 */
export async function appendAttempt(path: string, rec: AttemptRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf8');
}

export async function readAttempts(path: string): Promise<AttemptRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as AttemptRecord;
      } catch {
        throw new Error(`${path}:${i + 1} is not valid JSON`);
      }
    });
}

/** Rewrites the file. Used by `bench score` to attach fidelity to existing rows. */
export async function writeAttempts(path: string, recs: readonly AttemptRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, recs.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
}
