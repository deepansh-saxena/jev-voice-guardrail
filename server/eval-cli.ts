import { evaluate } from './evaluation';
const live = process.argv.includes('--providers');
const split = process.argv.includes('--held-out') ? 'held-out' : process.argv.includes('--tuning') ? 'tuning' : 'all';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
try {
  if (!live) throw new Error('Real judge evaluation incurs API charges. Run npm run eval -- --providers [--held-out|--tuning] to opt in.');
  const result = await evaluate('provider-replay', split, undefined, controller.signal);
  console.log(JSON.stringify({ source: result.source, file: result.file, summaries: result.summaries }, null, 2));
  if (result.status !== 'completed') process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Evaluation failed.');
  process.exitCode = 1;
}
