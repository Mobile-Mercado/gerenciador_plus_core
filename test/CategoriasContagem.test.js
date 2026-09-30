import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createRequire } from 'node:module';
import { RecalculateCategoryCountsUseCase } from '../src/application/stats/RecalculateCategoryCountsUseCase.js';
import { createStatsRoutes } from '../src/http/routes/statsRoutes.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';

// O modulo e CommonJS e vive em functions/: e o mesmo caminho que o BFF usa em
// producao, entao o teste tambem carrega por ele.
const require = createRequire(import.meta.url);
const contagem = require('../functions/categoriasContagem.js');

const CATALOGO = {
  categorias: ['bebidas', 'limpeza', 'mercearia'],
  subcategorias: ['cervejas', 'refrigerantes', 'sabao'],
  produtos: [
    { id: 'p1', isTrashed: false, categoriesIds: ['bebidas'], subcategoriesIds: ['cervejas'] },
    { id: 'p2', isTrashed: false, categoriesIds: ['bebidas', 'mercearia'], subcategoriesIds: ['refrigerantes'] },
    { id: 'p3', isTrashed: false, categoriesIds: ['limpeza'], subcategoriesIds: ['sabao'] },
    { id: 'p4', isTrashed: true, categoriesIds: ['limpeza'], subcategoriesIds: ['sabao'] },
  ],
};

// Firestore de mentira: so o que a contagem usa, contando as chamadas de agregacao.
function firestoreFalso(catalogo = CATALOGO, registro = { agregacoes: 0, gravado: null }) {
  const colecao = (nome, filtros = []) => ({
    where: (campo, operador, valor) => colecao(nome, [...filtros, { campo, operador, valor }]),
    select: () => colecao(nome, filtros),
    count: () => ({
      get: async () => {
        registro.agregacoes += 1;
        return { data: () => ({ count: aplica(catalogo.produtos, filtros).length }) };
      },
    }),
    get: async () => {
      const ids = nome === 'ProductCategories' ? catalogo.categorias : catalogo.subcategorias;
      return { docs: ids.map((id) => ({ id })) };
    },
  });
  const aplica = (produtos, filtros) => produtos.filter((produto) => filtros.every(({ campo, operador, valor }) => (
    operador === 'array-contains'
      ? (produto[campo] || []).includes(valor)
      : produto[campo] === valor)));
  const statsDoc = {
    set: async (data) => { registro.gravado = data; },
    get: async () => ({ data: () => registro.gravado }),
  };
  const storeRef = {
    id: 'store-1',
    collection: (nome) => (nome === 'Stats' ? { doc: () => statsDoc } : colecao(nome)),
  };
  return {
    registro,
    storeRef,
    collection: () => ({ doc: () => storeRef }),
  };
}

test('conta por categoria e por subcategoria, ignorando produto na lixeira', async () => {
  const { storeRef, registro } = firestoreFalso();

  const resultado = await contagem.contarCategorias({ storeRef });

  assert.deepEqual(resultado.porCategoria, { bebidas: 2, limpeza: 1, mercearia: 1 });
  assert.deepEqual(resultado.porSubcategoria, { cervejas: 1, refrigerantes: 1, sabao: 1 });
  assert.equal(resultado.totalAtivos, 3);
  assert.equal(resultado.categorias, 3);
  assert.equal(resultado.subcategorias, 3);
  // uma agregacao por categoria, uma por subcategoria e uma do total
  assert.equal(registro.agregacoes, 7);
});

test('a soma das categorias pode passar do total, e o documento diz por que', async () => {
  const { storeRef } = firestoreFalso();

  const resultado = await contagem.contarCategorias({ storeRef });
  const soma = Object.values(resultado.porCategoria).reduce((total, valor) => total + valor, 0);

  assert.equal(soma, 4);
  assert.equal(resultado.totalAtivos, 3);
  assert.match(resultado.observacao, /produto em duas categorias conta nas duas/);
  assert.match(resultado.observacao, /7\.062.*6\.410/);
});

test('grava em Stats/categoriasContagem e devolve o documento gravado', async () => {
  const { storeRef, registro } = firestoreFalso();

  const gravado = await contagem.recalcularCategorias({ storeRef, geradoEm: 'quando' });

  assert.equal(registro.gravado.geradoEm, 'quando');
  assert.equal(registro.gravado.version, contagem.CONTAGEM_VERSION);
  assert.deepEqual(gravado.porCategoria, { bebidas: 2, limpeza: 1, mercearia: 1 });
  assert.equal(gravado.geradoEm, 'quando');
});

test('mover um produto de categoria muda a contagem das duas envolvidas', async () => {
  const catalogo = JSON.parse(JSON.stringify(CATALOGO));
  const { storeRef } = firestoreFalso(catalogo);

  const antes = await contagem.contarCategorias({ storeRef });
  catalogo.produtos[0].categoriesIds = ['limpeza'];
  const depois = await contagem.contarCategorias({ storeRef });

  assert.equal(antes.porCategoria.bebidas, 2);
  assert.equal(antes.porCategoria.limpeza, 1);
  assert.equal(depois.porCategoria.bebidas, 1);
  assert.equal(depois.porCategoria.limpeza, 2);
  assert.equal(depois.totalAtivos, antes.totalAtivos);
});

function servidor({ permissions }) {
  const firestore = firestoreFalso();
  const accessRepository = {
    async findAccountByClaims() {
      return {
        uid: 'uid-1', userId: 'store-1', establishmentId: 'store-1', hasEstablishment: true, permissions,
      };
    },
  };
  const { requirePermission } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.headers.authorization = 'Bearer token-1';
    request.auth = { uid: 'uid-1', exp: Math.floor(Date.now() / 1000) + 3600 };
    next();
  });
  app.use('/api/stats', createStatsRoutes({
    recalculateCategoryCountsUseCase: new RecalculateCategoryCountsUseCase({
      firestore,
      accessRepository,
      counter: contagem,
    }),
    requirePermission,
  }));
  app.use(errorHandler);
  return app;
}

async function recalcular(app) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/stats/categorias/recalcular`, {
      method: 'POST',
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test('a rota recalcula e devolve o documento para quem tem products.edit', async () => {
  const { status, body } = await recalcular(servidor({
    permissions: { isAdmin: false, groupId: 'g-1', keys: ['products.edit'] },
  }));

  assert.equal(status, 200);
  assert.equal(body.data.totalAtivos, 3);
  assert.deepEqual(body.data.porCategoria, { bebidas: 2, limpeza: 1, mercearia: 1 });
  assert.ok(body.data.observacao);
});

test('a rota recusa quem nao tem products.edit', async () => {
  const { status, body } = await recalcular(servidor({
    permissions: { isAdmin: false, groupId: 'g-1', keys: ['products.view'] },
  }));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'permission_denied');
  assert.equal(body.error.key, 'products.edit');
});

test('o dono da loja passa sem chave especifica', async () => {
  const { status } = await recalcular(servidor({
    permissions: { isAdmin: true, groupId: null, keys: [] },
  }));

  assert.equal(status, 200);
});
