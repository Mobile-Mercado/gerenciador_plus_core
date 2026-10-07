import assert from 'node:assert/strict';
import test from 'node:test';
import cors from 'cors';
import express from 'express';
import { createDataRoutes } from '../src/http/routes/dataRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';

const ORIGEM = 'https://gerenciadormobile.web.app';

// Mesma ordem do app.js: CORS antes das rotas, conta autenticada, rotas de dados.
function servidor() {
  const registro = { assinaturas: 0 };
  const manageManagerData = {
    async subscribe() {
      registro.assinaturas += 1;
      return () => {};
    },
  };
  const app = express();
  app.use(cors({ origin: ORIGEM, credentials: true }));
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = { uid: 'uid-1', exp: Math.floor(Date.now() / 1000) + 3600, iat: 1 };
    next();
  });
  app.use('/api/data', createDataRoutes({ manageManagerData }));
  app.use(errorHandler);
  return { app, registro };
}

async function chamar(app, init) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/data/stream`, init);
    const texto = await response.text();
    return { status: response.status, headers: response.headers, texto };
  } finally {
    server.close();
  }
}

test('POST /api/data/stream responde 410 stream_desligado sem abrir assinatura', async () => {
  const { app, registro } = servidor();
  const resposta = await chamar(app, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGEM },
    body: JSON.stringify({ target: { kind: 'document', path: 'estabelecimentos/store-1' } }),
  });

  assert.equal(resposta.status, 410);
  assert.deepEqual(JSON.parse(resposta.texto), {
    error: { code: 'stream_desligado', message: 'Atualize a página do gerenciador.' },
  });
  assert.match(resposta.headers.get('content-type'), /application\/json/);
  assert.equal(registro.assinaturas, 0);
});

test('o 410 sai com CORS, para o painel antigo ler o status e parar de reconectar', async () => {
  const { app } = servidor();
  const resposta = await chamar(app, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGEM },
    body: '{}',
  });

  assert.equal(resposta.status, 410);
  assert.equal(resposta.headers.get('access-control-allow-origin'), ORIGEM);
});

test('OPTIONS /api/data/stream continua respondendo o CORS normal', async () => {
  const { app, registro } = servidor();
  const resposta = await chamar(app, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGEM,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });

  assert.equal(resposta.status, 204);
  assert.equal(resposta.headers.get('access-control-allow-origin'), ORIGEM);
  assert.match(resposta.headers.get('access-control-allow-methods'), /POST/);
  assert.equal(registro.assinaturas, 0);
});
