import { evaluate } from './evaluation';
const live = process.argv.includes('--providers');
const split = process.argv.includes('--held-out') ? 'held-out' : process.argv.includes('--tuning') ? 'tuning' : 'all';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
try {
  const result = await evaluate(live ? 'provider-replay' : 'fixture', split, undefined, controller.signal);
  console.log(JSON.stringify({ source: result.source, file: result.file, summaries: result.summaries }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Evaluation failed.');
  process.exitCode = 1;
}
