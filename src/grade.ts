// `pab grade`. cli.ts requires this module only when the command runs, so scoring, the report and
// the judge (with its SDK) stay out of everything else that loads the CLI, such as the recording
// tool.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadTarget, str, type Args } from './cli';
import { readJsonl } from './core/util';
import { parseGrading, validateGrading, type Grading } from './grading';
import { pickJudge } from './judge';
import { scoreRun, writeRun, type LogLine, type RunStats } from './scoring';
import { resolveTarget, type Repo } from './tasks';

export async function cmdGrade(positional: string[], flags: Args['flags'], repo: Repo): Promise<void> {
  const [arg] = positional;
  const logFile = str(flags.log);
  if (!arg || !logFile) throw new Error('usage: pab grade <task> --log <replay-log.jsonl> [--answer FILE] [--out DIR]');
  const target = await resolveTarget(arg, repo);
  const { bundle, rules } = loadTarget(target);
  const task = target.task;
  const card = task?.card();
  let grading: Grading | undefined;
  if (task && fs.existsSync(task.gradingPath)) {
    grading = parseGrading(fs.readFileSync(task.gradingPath, 'utf8'));
    const errors = validateGrading(grading);
    if (errors.length) throw new Error(`${task.gradingPath}:\n  ${errors.join('\n  ')}`);
  }
  const answer = str(flags.answer) ? fs.readFileSync(str(flags.answer)!, 'utf8') : undefined;
  const runFile = str(flags.run);
  const run = runFile ? (JSON.parse(fs.readFileSync(runFile, 'utf8')) as RunStats) : undefined;
  if (run && (Number.isNaN(Date.parse(run.started)) || Number.isNaN(Date.parse(run.finished)))) throw new Error(`${runFile}: started and finished must be ISO times`);
  const result = await scoreRun({
    task: { id: card?.id ?? target.name, title: card?.title, prompt: card?.prompt },
    grading,
    answer,
    log: readJsonl<LogLine>(logFile),
    logFile: path.resolve(logFile),
    rules,
    probes: Object.values(bundle.manifest().not_found ?? {}),
    judge: grading && answer !== undefined ? pickJudge(str(flags.judge), str(flags.model)) : undefined,
    run,
  });
  const out = str(flags.out) ?? path.join(repo.cacheDir, 'runs', `${target.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const files = writeRun(result, out);
  if (result.score !== undefined) console.log(`score ${(result.score * 100).toFixed(1)}%${result.grader ? ` (graded by ${result.grader.model})` : ''}`);
  for (const n of result.notes) console.log(n);
  console.log(`pages that returned 404: ${result.pages.not_found.length}`);
  for (const p of result.pages.not_found) console.log(`  [${p.source === 'miss' ? 'not recorded' : 'recorded as 404'}] x${p.count} ${p.route.slice(0, 140)}`);
  console.log(`result: ${files.json}`);
  console.log(`report: ${files.html}`);
  if (grading && answer !== undefined && result.score === undefined) process.exitCode = 1;
}
