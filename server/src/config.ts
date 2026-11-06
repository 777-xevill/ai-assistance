import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;

function str(name: string, fallback = ''): string {
  const v = env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function int(name: string, fallback: number): number {
  const n = Number(env[name]);
  return env[name] !== undefined && env[name]!.trim() !== '' && Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

export const rootDir = path.resolve(import.meta.dirname, '..', '..');
const isProd = str('NODE_ENV', 'development') === 'production';
const port = int('PORT', 3000);
const appUrl = str('APP_URL', `http://localhost:${port}`).replace(/\/+$/, '');
const dataDir = path.resolve(rootDir, str('DATA_DIR', 'data'));
fs.mkdirSync(dataDir, { recursive: true });

/**
 * The secret key encrypts channel tokens at rest and signs auth tokens.
 * In development a random key is generated once and stored in the data dir.
 * In production SECRET_KEY must be set (and never changed, or stored tokens become unreadable).
 */
function loadSecretKey(): string {
  const fromEnv = str('SECRET_KEY');
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('SECRET_KEY must be at least 32 characters long');
    return fromEnv;
  }
  if (isProd) throw new Error('SECRET_KEY is required in production');
  const file = path.join(dataDir, '.secret-key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const key = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

const appName = str('APP_NAME', 'AI Assistance');
const groqApiKey = str('GROQ_API_KEY');
/** Which LLM serves the assistant: 'groq' (free tier available) or 'anthropic' (Claude). */
const aiProvider: 'groq' | 'anthropic' =
  str('AI_PROVIDER').toLowerCase() === 'groq' ||
  (!str('AI_PROVIDER') && groqApiKey && !str('ANTHROPIC_API_KEY') && !env.ANTHROPIC_AUTH_TOKEN)
    ? 'groq'
    : 'anthropic';
const groqModel = str('GROQ_MODEL', 'openai/gpt-oss-120b');
const sttFromEnv = str('STT_API_KEY');
const aiModel = aiProvider === 'groq' ? groqModel : str('AI_MODEL', 'claude-opus-5-5');

export const config = {
  isProd,
  port,
  appName,
  /** Public URL of this server (webhooks, OAuth, media links). Must be HTTPS for Meta in production. */
  appUrl,
  /** URL of the dashboard. Same as APP_URL in production; the Vite dev server in development. */
  webUrl: str('WEB_URL', isProd ? appUrl : 'http://localhost:5173').replace(/\/+$/, ''),
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  /** Postgres connection string. When empty an embedded Postgres (PGlite) is used from DATA_DIR. */
  databaseUrl: str('DATABASE_URL'),
  secretKey: loadSecretKey(),
  trialDays: int('TRIAL_DAYS', 14),
  /** Set SIGNUPS_ENABLED=false to run invite-only: you add every client yourself from the admin console. */
  signupsEnabled: str('SIGNUPS_ENABLED', 'true').toLowerCase() !== 'false',
  superadminEmails: str('SUPERADMIN_EMAILS')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  ai: {
    provider: aiProvider,
    apiKey: str('ANTHROPIC_API_KEY'),
    groq: {
      apiKey: groqApiKey,
      baseUrl: str('GROQ_BASE_URL', 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
      /** Used whenever a request contains a photo (the main model is text-only). */
      visionModel: str('GROQ_VISION_MODEL', 'qwen/qwen3.8-27b'),
    },
    model: aiModel,
    /** Used for background work (image descriptions, imports). Defaults to the main model. */
    backgroundModel: str('AI_BACKGROUND_MODEL', aiModel),
    effort: str('AI_EFFORT', 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    /** Replies with canned text instead of calling Claude. Useful for testing channel setups. */
    mock: bool('AI_MOCK', false),
  },
  stt: {
    /** Any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, a self-hosted Whisper server...). */
    // With no STT_API_KEY, the Groq key is used (Whisper on Groq).
    apiKey: sttFromEnv || groqApiKey,
    baseUrl: str('STT_BASE_URL', !sttFromEnv && groqApiKey ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: str('STT_MODEL', !sttFromEnv && groqApiKey ? 'whisper-large-v3-turbo' : 'whisper-1'),
  },
  meta: {
    appId: str('META_APP_ID'),
    appSecret: str('META_APP_SECRET'),
    verifyToken: str('META_VERIFY_TOKEN'),
    graphVersion: str('META_GRAPH_VERSION', 'v26.0'),
    graphBase: str('META_GRAPH_BASE', 'https://graph.facebook.com').replace(/\/+$/, ''),
    /** Facebook Login for Business configuration used to connect Pages (Messenger + Instagram). Optional. */
    loginConfigId: str('META_LOGIN_CONFIG_ID'),
    /** Facebook Login for Business configuration for WhatsApp Embedded Signup. */
    whatsappConfigId: str('META_WA_CONFIG_ID'),
  },
  telegramApiBase: str('TELEGRAM_API_BASE', 'https://api.telegram.org').replace(/\/+$/, ''),
  manychatApiBase: str('MANYCHAT_API_BASE', 'https://api.manychat.com').replace(/\/+$/, ''),
  mail: {
    /** e.g. smtps://user:pass@smtp.example.com:465 — when empty, emails are printed to the console. */
    smtpUrl: str('SMTP_URL'),
    from: str('MAIL_FROM', `${appName} <no-reply@example.com>`),
  },
  worker: {
    enabled: bool('WORKER_ENABLED', true),
    concurrency: int('WORKER_CONCURRENCY', 10),
  },
  /** How long to wait for a customer to stop typing before replying (they often send several messages). */
  replyDebounceMs: int('REPLY_DEBOUNCE_MS', 4000),
  /** Upper bound on that wait, measured from the first unanswered message. */
  replyMaxWaitMs: int('REPLY_MAX_WAIT_MS', 15000),
  /** Simulate human typing speed before each chat bubble (disabled in tests). */
  typingDelay: bool('TYPING_DELAY', true),
};

export const metaConfigured = () => Boolean(config.meta.appId && config.meta.appSecret);
