import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_CORS_ORIGINS = Object.freeze([
  'https://gerenciadormobile.web.app',
  'https://gerenciadormobile.firebaseapp.com',
  'https://appmobileprod-19505.web.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
]);

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'sim'].includes(String(value).trim().toLowerCase());
}

export function parseOrigins(value) {
  const configured = String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [...new Set([...REQUIRED_CORS_ORIGINS, ...configured])];
}

function parseList(value) {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseAiProvider(value) {
  const provider = String(value || 'openai').trim().toLowerCase();
  if (provider === 'openai' || provider === 'groq') return provider;
  throw new Error('AI_PROVIDER deve ser "openai" ou "groq".');
}

const nodeEnv = process.env.NODE_ENV || 'development';

export const env = Object.freeze({
  NODE_ENV: nodeEnv,
  PORT: toInteger(process.env.PORT, 8080),
  CORS_ORIGINS: parseOrigins(process.env.CORS_ORIGINS),
  AI_PROVIDER: parseAiProvider(process.env.AI_PROVIDER),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  OPENAI_TEMPERATURE: toNumber(process.env.OPENAI_TEMPERATURE, 0.2),
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  GROQ_MODEL: process.env.GROQ_MODEL || 'qwen/qwen3.6-27b',
  GROQ_TEMPERATURE: toNumber(process.env.GROQ_TEMPERATURE, 0.2),
  REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT || '10mb',
  REQUIRE_FIREBASE_AUTH: toBoolean(
    process.env.REQUIRE_FIREBASE_AUTH,
    nodeEnv === 'production',
  ),
  IMPLANTATION_ADMIN_UIDS: parseList(process.env.IMPLANTATION_ADMIN_UIDS),
  COUPON_ADMIN_UIDS: parseList(process.env.COUPON_ADMIN_UIDS),
});

export function isProduction() {
  return env.NODE_ENV === 'production';
}
