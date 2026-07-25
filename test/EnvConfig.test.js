import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOrigins } from '../src/config/env.js';

test('mantem localhost e dominios oficiais quando o Console sobrescreve CORS_ORIGINS', () => {
  const origins = parseOrigins('https://gerenciadormobile.web.app');

  assert.ok(origins.includes('https://gerenciadormobile.web.app'));
  assert.ok(origins.includes('https://gerenciadormobile.firebaseapp.com'));
  assert.ok(origins.includes('http://localhost:5173'));
  assert.ok(origins.includes('http://127.0.0.1:5173'));
  assert.equal(origins.filter((origin) => origin === 'https://gerenciadormobile.web.app').length, 1);
});
