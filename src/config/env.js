import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_CORS_ORIGINS = Object.freeze([
  'https://gerenciadormobile.web.app',
  'https://gerenciadormobile.firebaseapp.com',
  'https://gerenciador-691f9.web.app',
  'https://gerenciador-691f9.firebaseapp.com',
  'https://mobilegerenciador.com.br',
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
  // Bucket dos icones de categoria da lista padrao (Admin).
  STORAGE_BUCKET: process.env.STORAGE_BUCKET || 'appmobileprod-19505.appspot.com',
  // Projeto do Firestore para as gravacoes pela API REST (banners com tamanho em decimal).
  FIRESTORE_PROJECT_ID: process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'appmobileprod-19505',
  // Cadastro de loja: App Check preparado e desligado ate o app gerenciador mandar o token.
  CADASTRO_EXIGE_APP_CHECK: toBoolean(process.env.CADASTRO_EXIGE_APP_CHECK, false),
  // "Atualizar agora" da tela Instalacoes do Admin: os mesmos parametros da rotina instalacoesAppNightly
  // (functions/.env.appmobileprod-19505), a conta de servico que le os relatorios e o nome do segredo
  // da chave da Apple no Secret Manager. A chave nunca fica aqui.
  INSTALACOES_PROJETO: process.env.INSTALACOES_PROJETO || 'appmobileprod-19505',
  INSTALACOES_CONTA_DE_SERVICO: process.env.INSTALACOES_CONTA_DE_SERVICO || '',
  PLAY_REPORTS_BUCKET: process.env.PLAY_REPORTS_BUCKET || '',
  APPLE_ISSUER_ID: process.env.APPLE_ISSUER_ID || '',
  APPLE_KEY_ID: process.env.APPLE_KEY_ID || '',
  APPLE_RELATORIOS_SEGREDO: process.env.APPLE_RELATORIOS_SEGREDO || 'APPLE_RELATORIOS_LEITURA_P8',
});

export function isProduction() {
  return env.NODE_ENV === 'production';
}
