import { aiConfigured } from './ai/client.ts';
import { transcriptionEnabled } from './ai/transcribe.ts';
import { createApp } from './app.ts';
import { config, metaConfigured } from './config.ts';
import { closeDb, initDb } from './db/index.ts';
import { registerJobs } from './jobs/index.ts';
import { logger } from './lib/logger.ts';
import { enqueue, startWorker, stopWorker } from './queue/index.ts';

await initDb();
registerJobs();

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info(`${config.appName} API listening on port ${config.port} (public URL ${config.appUrl})`);
  if (!config.isProd) logger.info(`Dashboard: ${config.webUrl}`);
});

if (config.worker.enabled) {
  startWorker();
  await enqueue('scheduler.tick', {}, { uniqueKey: 'scheduler.tick' });
}

if (!aiConfigured()) logger.warn('No AI key is set (GROQ_API_KEY or ANTHROPIC_API_KEY): AI replies will fail until one is configured (or set AI_MOCK=true to test).');
if (config.ai.mock) logger.warn('AI_MOCK is on: replies are canned test messages, not Claude.');
if (!transcriptionEnabled()) logger.info('STT_API_KEY is not set: voice messages will not be transcribed.');
if (!metaConfigured()) logger.info('META_APP_ID / META_APP_SECRET not set: Messenger, Instagram and WhatsApp connections are disabled.');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down…`);
  server.close();
  await stopWorker();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error('Unhandled promise rejection', { err }));
