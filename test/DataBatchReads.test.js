import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { AppError } from '../src/domain/errors/AppError.js';
import { ManageManagerData } from '../src/application/data/ManageManagerData.js';
import { createDataRoutes } from '../src/http/routes/dataRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';

const CONTA = {
  uid: 'uid-1',
  userId: 'store-1',
  establishmentId: 'store-1',
  hasEstablishment: true,
  permissions: { isAdmin: true, groupId: null, keys: [] },
};

function repositorio(registro = { chamadas: 0 }) {
  return {
    registro,
    async findAccountByClaims() {
      registro.chamadas += 1;
      return CONTA;
    },
  };
}

// Gateway de mentira: registra a ordem das leituras e nega o que a loja nao pode ler.
function gateway(registro = { leituras: [], abertas: 0, simultaneas: 0 }) {
  const negado = (path) => !String(path || '').startsWith('estabelecimentos/store-1');
  const trabalho = async (tipo, target) => {
    registro.abertas += 1;
    registro.simultaneas = Math.max(registro.simultaneas, registro.abertas);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    registro.abertas -= 1;
    const path = target?.path || target?.source?.path;
    registro.leituras.push(`${tipo}:${path}`);
    if (negado(path)) {
      throw new AppError('Acesso aos dados solicitado nao permitido.', {
        statusCode: 403,
        code: 'data_access_forbidden',
      });
    }
    if (path.endsWith('Quebrado')) throw new Error('9 FAILED_PRECONDITION: The query requires an index.');
    if (tipo === 'count') return { count: path.length };
    if (tipo === 'document') return { id: 'doc', path, exists: true, data: {} };
    return { docs: [{ id: 'a', path }], size: 1, empty: false };
  };
  return {
    registro,
    getDocument: ({ target }) => trabalho('document', target),
    getDocuments: ({ target }) => trabalho('query', target),
    countDocuments: ({ target }) => trabalho('count', target),
  };
}

function servidor({ manageManagerData }) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = { uid: 'uid-1', exp: Math.floor(Date.now() / 1000) + 3600, iat: 1 };
    next();
  });
  app.use('/api/data', createDataRoutes({ manageManagerData }));
  app.use(errorHandler);
  return app;
}

async function chamar(app, body) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/data/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

function alvo(path, kind = 'query') {
  return { kind, target: { kind: 'collection', path } };
}

test('devolve uma resposta por leitura, na mesma ordem da entrada', async () => {
  const manageManagerData = new ManageManagerData({ accessRepository: repositorio(), gateway: gateway() });
  const reads = [
    alvo('estabelecimentos/store-1/Products', 'count'),
    alvo('estabelecimentos/store-1/ProductCategories'),
    { kind: 'document', target: { kind: 'document', path: 'estabelecimentos/store-1' } },
  ];

  const { status, body } = await chamar(servidor({ manageManagerData }), { reads });

  assert.equal(status, 200);
  assert.equal(body.data.length, 3);
  assert.deepEqual(body.data.map((item) => item.ok), [true, true, true]);
  assert.equal(body.data[0].data.count, 'estabelecimentos/store-1/Products'.length);
  assert.equal(body.data[1].data.docs[0].path, 'estabelecimentos/store-1/ProductCategories');
  assert.equal(body.data[2].data.path, 'estabelecimentos/store-1');
});

test('a identificacao da conta acontece uma vez para a chamada inteira', async () => {
  const registro = { chamadas: 0 };
  const manageManagerData = new ManageManagerData({
    accessRepository: repositorio(registro),
    gateway: gateway(),
  });

  const { body } = await chamar(servidor({ manageManagerData }), {
    reads: Array.from({ length: 7 }, () => alvo('estabelecimentos/store-1/Products', 'count')),
  });

  assert.equal(body.data.length, 7);
  assert.equal(registro.chamadas, 1);
});

test('as leituras correm em paralelo', async () => {
  const registro = { leituras: [], abertas: 0, simultaneas: 0 };
  const manageManagerData = new ManageManagerData({
    accessRepository: repositorio(),
    gateway: gateway(registro),
  });

  await chamar(servidor({ manageManagerData }), {
    reads: Array.from({ length: 5 }, () => alvo('estabelecimentos/store-1/Products')),
  });

  assert.equal(registro.simultaneas, 5);
});

test('leitura sem permissao volta como erro so naquele item', async () => {
  const manageManagerData = new ManageManagerData({ accessRepository: repositorio(), gateway: gateway() });

  const { status, body } = await chamar(servidor({ manageManagerData }), {
    reads: [
      alvo('estabelecimentos/store-1/Products'),
      alvo('estabelecimentos/store-2/Products'),
      alvo('estabelecimentos/store-1/ProductCategories', 'count'),
    ],
  });

  assert.equal(status, 200);
  assert.deepEqual(body.data.map((item) => item.ok), [true, false, true]);
  assert.equal(body.data[1].error.code, 'data_access_forbidden');
  assert.ok(body.data[0].data.docs.length);
  assert.equal(body.data[2].data.count, 'estabelecimentos/store-1/ProductCategories'.length);
});

test('falha inesperada de uma leitura nao vaza o motivo e nao derruba as outras', async () => {
  const manageManagerData = new ManageManagerData({ accessRepository: repositorio(), gateway: gateway() });

  const { body } = await chamar(servidor({ manageManagerData }), {
    reads: [alvo('estabelecimentos/store-1/Quebrado'), alvo('estabelecimentos/store-1/Products')],
  });

  assert.equal(body.data[0].ok, false);
  assert.equal(body.data[0].error.code, 'internal_error');
  assert.ok(!body.data[0].error.message.includes('FAILED_PRECONDITION'));
  assert.equal(body.data[1].ok, true);
});

test('tipo de leitura invalido e erro daquele item', async () => {
  const manageManagerData = new ManageManagerData({ accessRepository: repositorio(), gateway: gateway() });

  const { body } = await chamar(servidor({ manageManagerData }), {
    reads: [{ kind: 'stream', target: { kind: 'collection', path: 'estabelecimentos/store-1/Products' } }],
  });

  assert.equal(body.data[0].ok, false);
  assert.equal(body.data[0].error.code, 'data_batch_read_kind_invalid');
});

test('recusa lista vazia e lista acima de 25 leituras', async () => {
  const manageManagerData = new ManageManagerData({ accessRepository: repositorio(), gateway: gateway() });
  const app = servidor({ manageManagerData });

  const vazia = await chamar(app, { reads: [] });
  assert.equal(vazia.status, 400);
  assert.equal(vazia.body.error.code, 'data_batch_reads_empty');

  const demais = await chamar(app, {
    reads: Array.from({ length: 26 }, () => alvo('estabelecimentos/store-1/Products', 'count')),
  });
  assert.equal(demais.status, 400);
  assert.equal(demais.body.error.code, 'data_batch_reads_limit');

  const limite = await chamar(app, {
    reads: Array.from({ length: 25 }, () => alvo('estabelecimentos/store-1/Products', 'count')),
  });
  assert.equal(limite.status, 200);
  assert.equal(limite.body.data.length, 25);
});

test('as rotas antigas continuam respondendo como antes', async () => {
  const manageManagerData = new ManageManagerData({ accessRepository: repositorio(), gateway: gateway() });
  const app = servidor({ manageManagerData });
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const alvoUnico = { target: { kind: 'collection', path: 'estabelecimentos/store-1/Products' } };
    for (const [rota, confere] of [
      ['query', (data) => assert.equal(data.docs.length, 1)],
      ['count', (data) => assert.equal(data.count, 'estabelecimentos/store-1/Products'.length)],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/data/${rota}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alvoUnico),
      });
      assert.equal(response.status, 200);
      confere((await response.json()).data);
    }
  } finally {
    server.close();
  }
});
