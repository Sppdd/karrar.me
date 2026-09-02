#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { stderr, stdout } from 'node:process';
import { createProvider } from '@vidgen/providers';
import { format, money } from '@vidgen/shared';
import { CATEGORIES, type Category, fixturesFor } from './fixtures.ts';
import { renderMarkdown, summarize } from './report.ts';
import { run } from './runner.ts';
import { scoreInteractive } from './score.ts';
import { readAttempts } from './store.ts';

const USAGE = `
bench - Phase 0 provider benchmark

  bench run [options]      dispatch generations and record attempts
  bench score [options]    attach human fidelity scores to recorded clips
  bench report [options]   summarise cost, latency and regeneration rate
  bench estimate [options] price a run WITHOUT calling any provider

Options
  --provider <id,...>   mock | veo | kling | runway         (default: mock)
  --category <name,...> ${CATEGORIES.join(' | ')}
  --tier <draft|final>  (default: draft)
  --attempts <n>        attempts per fixture per provider    (default: 1)
  --out <path>          results JSONL       (default: results/attempts.jsonl)
  --concurrency <n>     (default: 3)
  --timeout <ms>        per-attempt ceiling  (default: 600000)
  --poll <ms>           poll interval        (default: 5000)
  --yes                 skip the cost confirmation prompt
  --rescore             re-score already-scored clips
  --show-provider       reveal provider identity while scoring (default: blind)
  --markdown <path>     also write the report to a file
`.trim();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: 'string', default: 'mock' },
    category: { type: 'string' },
    tier: { type: 'string', default: 'draft' },
    attempts: { type: 'string', default: '1' },
    out: { type: 'string', default: 'results/attempts.jsonl' },
    concurrency: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '600000' },
    poll: { type: 'string', default: '5000' },
    yes: { type: 'boolean', default: false },
    rescore: { type: 'boolean', default: false },
    'show-provider': { type: 'boolean', default: false },
    markdown: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0];
if (values.help || !command) {
  stdout.write(`${USAGE}\n`);
  process.exit(values.help ? 0 : 1);
}

const tier = values.tier === 'final' ? 'final' : 'draft';
const categories = values.category
  ? (values.category.split(',').map((s) => s.trim()) as Category[])
  : undefined;

for (const c of categories ?? []) {
  if (!CATEGORIES.includes(c)) {
    stderr.write(`unknown category "${c}". Known: ${CATEGORIES.join(', ')}\n`);
    process.exit(1);
  }
}

const fixtures = fixturesFor(categories);
const providerIds = values.provider.split(',').map((s) => s.trim()).filter(Boolean);
const attempts = Number(values.attempts);

try {
  switch (command) {
    case 'run':
      await cmdRun();
      break;
    case 'estimate':
      cmdEstimate();
      break;
    case 'score':
      await scoreInteractive({
        path: values.out,
        rescore: values.rescore,
        blind: !values['show-provider'],
      });
      break;
    case 'report':
      await cmdReport();
      break;
    default:
      stderr.write(`unknown command "${command}"\n\n${USAGE}\n`);
      process.exit(1);
  }
} catch (e) {
  stderr.write(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

function buildProviders() {
  return providerIds.map(createProvider);
}

/** Pre-flight cost, from the pricing table, with no provider call. */
function cmdEstimate(): void {
  const providers = buildProviders();
  const currency = 'USD';
  let total = money(0n, currency);

  stdout.write(`${fixtures.length} fixtures x ${providerIds.length} provider(s) x ${attempts} attempt(s), tier=${tier}\n\n`);
  for (const p of providers) {
    let providerTotal = money(0n, currency);
    for (const f of fixtures) {
      for (let i = 0; i < attempts; i++) {
        const est = p.estimate(f.spec, tier);
        providerTotal = money(providerTotal.micros + est.micros, currency);
      }
    }
    total = money(total.micros + providerTotal.micros, currency);
    stdout.write(`  ${p.id.padEnd(8)} ${p.model.padEnd(16)} ${format(providerTotal)}\n`);
  }
  stdout.write(`\n  ${'TOTAL'.padEnd(25)} ${format(total)}\n`);
  stdout.write('\nEstimates come from the seeded pricing table, which is NOT invoice-verified.\nTreat as order-of-magnitude until `bench report` has measured billed costs.\n');
}

async function cmdRun(): Promise<void> {
  const providers = buildProviders();
  const usesRealProvider = providerIds.some((id) => id !== 'mock');

  cmdEstimate();

  if (usesRealProvider && !values.yes) {
    stdout.write('\nThis will call real providers and spend real money.\nRe-run with --yes to proceed.\n');
    process.exit(1);
  }

  const total = fixtures.length * providers.length * attempts;
  stdout.write(`\nRunning ${total} attempts...\n`);

  const records = await run({
    providers,
    fixtures,
    tier,
    attempts,
    outPath: values.out,
    concurrency: Number(values.concurrency),
    pollIntervalMs: Number(values.poll),
    timeoutMs: Number(values.timeout),
    onEvent: (e) => {
      if (e.kind === 'attempt') {
        const r = e.record;
        const mark = r.outcome === 'succeeded' ? 'ok  ' : 'FAIL';
        stdout.write(
          `  [${String(e.done).padStart(3)}/${e.total}] ${mark} ${r.providerId}/${r.fixtureId} #${r.attempt} ${r.latencyMs}ms\n`,
        );
      } else if (e.kind === 'error') {
        stderr.write(`  !! ${e.task.providerId}/${e.task.fixtureId} #${e.task.attempt}: ${e.error.message}\n`);
      }
    },
  });

  const failed = records.filter((r) => r.outcome === 'failed').length;
  stdout.write(`\nWrote ${records.length} attempts to ${values.out} (${failed} failed)\n`);
  stdout.write('Next: `bench score` to attach fidelity, then `bench report`.\n');
}

async function cmdReport(): Promise<void> {
  const records = await readAttempts(values.out);
  const md = renderMarkdown(records);
  stdout.write(`${md}\n`);

  if (values.markdown) {
    await writeFile(values.markdown, `${md}\n`, 'utf8');
    stderr.write(`\nwrote ${values.markdown}\n`);
  }

  // Non-zero exit when the headline number is not yet trustworthy, so CI or a
  // wrapper script cannot mistake an unscored run for a finished one.
  const anyRate = summarize(records).some((s) => s.regenerationRate !== null);
  if (records.length && !anyRate) process.exitCode = 2;
}
