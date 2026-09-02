import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readAttempts, writeAttempts } from './store.ts';
import type { AttemptRecord } from './types.ts';

/**
 * Human fidelity scoring.
 *
 * Deliberately manual and deliberately blind to provider: no automated metric
 * for "does the character still look like the character" exists yet, and the
 * point of Phase 0 is an honest number rather than a convenient one.
 */
export interface ScoreOptions {
  readonly path: string;
  readonly rescore: boolean;
  /** Hide provider identity while scoring, to keep the judgement honest. */
  readonly blind: boolean;
}

/** Returns the next answer, or null when input is exhausted. */
export type Asker = (prompt: string) => Promise<string | null>;

export async function scoreInteractive(opts: ScoreOptions): Promise<number> {
  const { ask, close } = stdin.isTTY ? ttyAsker() : pipedAsker(await readAll());
  try {
    return await scoreWith(opts, ask);
  } finally {
    close();
  }
}

/** The scoring loop, independent of where answers come from. Exported for tests. */
export async function scoreWith(opts: ScoreOptions, ask: Asker): Promise<number> {
  const all = await readAttempts(opts.path);
  const targets = all.filter(
    (r) => r.outcome === 'succeeded' && (opts.rescore || typeof r.fidelity !== 'number'),
  );

  if (!targets.length) {
    stdout.write('Nothing to score. (Failed attempts are not scored.)\n');
    return 0;
  }

  const order = opts.blind ? shuffle(targets) : targets;
  let scored = 0;

  stdout.write(
    `Scoring ${order.length} clips. 1 = unusable, 5 = shippable. ` +
      `Enter to skip, 'q' to save and quit.\n\n`,
  );

  try {
    for (const [i, rec] of order.entries()) {
      const label = opts.blind
        ? `${rec.fixtureId} (${rec.category})`
        : `${rec.fixtureId} (${rec.category}) via ${rec.providerId}/${rec.model}`;
      stdout.write(`[${i + 1}/${order.length}] ${label}\n  ${rec.clipUrl}\n`);

      const raw = await ask('  fidelity 1-5 > ');
      if (raw === null) break; // EOF: Ctrl-D, or piped input exhausted
      const answer = raw.trim().toLowerCase();
      if (answer === 'q') break;
      if (!answer) {
        stdout.write('  skipped\n\n');
        continue;
      }

      const value = Number(answer);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        stdout.write('  not 1-5, skipped\n\n');
        continue;
      }

      const note = (await ask('  note (optional) > '))?.trim() ?? '';
      applyScore(all, rec, value, note);
      scored++;
      stdout.write('\n');
    }
  } finally {
    // Save whatever was scored, including on an early quit - these judgements
    // cost real human time and must not be thrown away.
    await writeAttempts(opts.path, all);
  }

  stdout.write(`Saved ${scored} score(s) to ${opts.path}\n`);
  return scored;
}

/**
 * Interactive terminal.
 *
 * readline's `question` never settles once the stream closes, so a Ctrl-D would
 * hang the process and skip the save in `finally`, losing every judgement made
 * so far. Racing against 'close' turns EOF into a clean quit.
 */
function ttyAsker(): { ask: Asker; close: () => void } {
  const rl: Interface = createInterface({ input: stdin, output: stdout });
  let closed = false;
  rl.once('close', () => {
    closed = true;
  });

  const ask: Asker = async (prompt) => {
    if (closed) return null;
    let onClose: () => void = () => {};
    const onClosed = new Promise<null>((resolve) => {
      onClose = () => resolve(null);
      rl.once('close', onClose);
    });
    try {
      return await Promise.race([rl.question(prompt), onClosed]);
    } finally {
      rl.removeListener('close', onClose);
    }
  };

  return { ask, close: () => rl.close() };
}

/**
 * Non-TTY: read stdin to the end first, then serve it a line at a time.
 *
 * readline cannot be used here - it emits every buffered line immediately and
 * drops the ones with no pending `question`, so a piped scoring session would
 * silently record only its first answer.
 */
export function pipedAsker(input: string): { ask: Asker; close: () => void } {
  const lines = input.split('\n');
  if (lines.at(-1) === '') lines.pop(); // trailing newline is not an answer
  let i = 0;

  const ask: Asker = async (prompt) => {
    if (i >= lines.length) return null;
    const line = lines[i++] as string;
    stdout.write(`${prompt}${line}\n`);
    return line;
  };

  return { ask, close: () => {} };
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Exported for tests: mutate the record in place within `all`. */
export function applyScore(
  all: AttemptRecord[],
  target: AttemptRecord,
  fidelity: number,
  note?: string,
): void {
  const i = all.findIndex(
    (r) => r.runId === target.runId && r.idempotencyKey === target.idempotencyKey,
  );
  if (i === -1) throw new Error(`record not found: ${target.idempotencyKey}`);
  const existing = all[i] as AttemptRecord;
  all[i] = {
    ...existing,
    fidelity,
    scoredAt: new Date().toISOString(),
    ...(note ? { scoreNote: note } : {}),
  };
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
