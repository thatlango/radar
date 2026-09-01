import { scraperManager } from '../scrapers/scraperManager';

async function main() {
  const started = new Date();
  console.log(`[Radar] scan started ${started.toISOString()}`);
  const result = await scraperManager.runAll();
  console.log(JSON.stringify({ started, finished: new Date(), ...result }, null, 2));
  if (!result.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[Radar] scan failed', error);
  process.exitCode = 1;
});
