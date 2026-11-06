// Minimal structured logger. Writes one line per entry; extra fields are appended as JSON.

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';

function fmtExtra(extra?: Record<string, unknown>): string {
  if (!extra || Object.keys(extra).length === 0) return '';
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    safe[k] = v instanceof Error ? { message: v.message, stack: v.stack?.split('\n').slice(0, 4).join(' | ') } : v;
  }
  try {
    return ' ' + JSON.stringify(safe);
  } catch {
    return ' [unserialisable]';
  }
}

function log(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < order[minLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${fmtExtra(extra)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>) => log('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => log('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => log('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => log('error', msg, extra),
};
