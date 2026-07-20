import dotenv from 'dotenv';

dotenv.config();

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

function parseOrigins(value) {
  if (!value) {
    return [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ];
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseList(value) {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV || 'development';

export const env = Object.freeze({
  NODE_ENV: nodeEnv,
  PORT: toInteger(process.env.PORT, 8080),
  CORS_ORIGINS: parseOrigins(process.env.CORS_ORIGINS),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  OPENAI_TEMPERATURE: toNumber(process.env.OPENAI_TEMPERATURE, 0.2),
  REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT || '10mb',
  REQUIRE_FIREBASE_AUTH: toBoolean(
    process.env.REQUIRE_FIREBASE_AUTH,
    nodeEnv === 'production',
  ),
  IMPLANTATION_ADMIN_UIDS: parseList(process.env.IMPLANTATION_ADMIN_UIDS),
});

export function isProduction() {
  return env.NODE_ENV === 'production';
}
