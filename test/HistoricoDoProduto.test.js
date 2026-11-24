import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import express from 'express';
import { HistoricoDoProduto, origemNormalizada } from '../src/application/produtos/HistoricoDoProduto.js';
import {
  FirestoreHistoricoDoProdutoRepository, LIMITE_SEM_INDICE, faltaIndice,
} from '../src/infra/firebase/FirestoreHistoricoDoProdutoRepository.js';
import { createProdutosRoutes } from '../src/http/routes/produtosRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola 65, item 3.5 (revisado): historico do produto lido do Log das acoes da equipe
// (estabelecimentos/{loja}/AcoesEquipe), sem colecao nova. Falham com o codigo de antes: a rota,
// o caso de uso e o repositorio nao existiam.

const LOJA = 'loja-1';
const OUTRA = 'loja-2';
const acao = (id, dados, loja = LOJA) => [`estabelecimentos/${loja}/AcoesEquipe/${id}`, dados];

function bancoComLog() {
  return new FirestoreEmMemoria(Object.fromEntries([
    [`estabelecimentos/${LOJA}`, { name: 'Loja 1' }],
    acao('a1', {
      em: new Date('2026-11-10T12:00:00Z'), quem: 'dono@loja.com', tela: 'produtos', acao: 'produto.criar',
      alvo: { tipo: 'produto', id: 'p1', rotulo: 'Arroz' }, antes: null, depois: { name: 'Arroz' }, origem: 'manual',
    }),
    acao('a2', {
      em: new Date('2026-11-12T12:00:00Z'), quem: 'dono@loja.com', tela: 'produtos', acao: 'produto.editar',
      alvo: { tipo: 'produto', id: 'p1', rotulo: 'Arroz' },
      antes: { currentPrice: 10, promotionEndAt: null },
      depois: { currentPrice: 9.5, promotionEndAt: new Date('2026-11-30T02:59:59Z') },
      origem: 'manual',
    }),
    acao('a3', {
      em: new Date('2026-11-15T12:00:00Z'), quem: 'func@loja.com', tela: 'produtos', acao: 'produto.editar',
      alvo: { tipo: 'produto', id: 'p1', rotulo: 'Arroz' }, antes: { quantityInStock: 3 }, depois: { quantityInStock: 2 },
      origem: 'app', versaoDoApp: '1.2.3', aparelho: 'x',
    }),
    acao('a4', {
      em: new Date('2026-11-16T03:05:00Z'), quem: '', tela: 'produtos', acao: 'produto.editar',
      alvo: { tipo: 'produto', id: 'p1', rotulo: 'Arroz' }, antes: { promotionalPrice: 7 }, depois: { promotionalPrice: null },
      origem: 'removerPromocaoVencidaNightly',
    }),
    // Outro produto, outro tipo de alvo com o mesmo id e outra loja: ficam de fora.
    acao('b1', { em: new Date('2026-11-16T12:00:00Z'), acao: 'produto.editar', alvo: { tipo: 'produto', id: 'p2' }, origem: 'manual' }),
    acao('b2', { em: new Date('2026-11-16T12:00:00Z'), acao: 'aceitar', alvo: { tipo: 'pedido', id: 'p1' }, origem: 'app' }),
    acao('c1', { em: new Date('2026-11-16T12:00:00Z'), quem: 'outro@x.com', acao: 'produto.editar', alvo: { tipo: 'produto', id: 'p1' }, origem: 'manual' }, OUTRA),
  ]));
}

async function subirRota({ banco = bancoComLog(), conta = { establishmentId: LOJA, hasEstablishment: true } } = {}) {
  const historicoDoProduto = new HistoricoDoProduto({ repositorio: new FirestoreHistoricoDoProdutoRepository({ firestore: banco }) });
  const app = express();
  app.use((request, _response, next) => { request.auth = { uid: 'uid-dono' }; next(); });
  app.use('/api/produtos', createProdutosRoutes({ historicoDoProduto, accountForRequest: async () => conta }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/produtos`;
  return {
    chamar: async (caminho) => {
      const resposta = await fetch(`${base}${caminho}`);
      return { status: resposta.status, corpo: await resposta.json() };
    },
    fechar: () => { servidor.closeAllConnections(); servidor.close(); },
  };
}

test('3.5: GET /api/produtos/:id/historico devolve as linhas do produto da loja, da mais nova para a mais antiga', async () => {
  const rota = await subirRota();
  try {
    const { status, corpo } = await rota.chamar('/p1/historico');
    assert.equal(status, 200);
    const { produtoId, completo, linhas } = corpo.data;
    assert.equal(produtoId, 'p1');
    assert.equal(completo, true);
    assert.deepEqual(linhas.map((linha) => linha.id), ['a4', 'a3', 'a2', 'a1']);
    assert.deepEqual(linhas.map((linha) => linha.origem), ['removerPromocaoVencidaNightly', 'app', 'web', 'web']);
    assert.equal(linhas[3].origemGravada, 'manual');
    assert.equal(linhas[2].quando, '2026-11-12T12:00:00.000Z');
    assert.equal(linhas[2].quem, 'dono@loja.com');
    assert.deepEqual(linhas[2].campos, [
      { campo: 'currentPrice', antes: 10, depois: 9.5 },
      { campo: 'promotionEndAt', antes: null, depois: '2026-11-30T02:59:59.000Z' },
    ]);
    assert.deepEqual(linhas[3].campos, [{ campo: 'name', antes: null, depois: 'Arroz' }]);
    // So o que o historico promete: nada de aparelho nem versao do app.
    assert.deepEqual(Object.keys(linhas[1]).sort(), ['acao', 'campos', 'id', 'motivo', 'origem', 'origemGravada', 'quando', 'quem', 'tela']);
    assert.equal(linhas[1].motivo, null);
    assert.ok(!JSON.stringify(corpo).includes('outro@x.com'), 'linha de outra loja nao sai');
  } finally {
    rota.fechar();
  }
});

test('3.5: limite, produto invalido e conta sem loja', async () => {
  const rota = await subirRota();
  try {
    const { corpo } = await rota.chamar('/p1/historico?limite=2');
    assert.deepEqual(corpo.data.linhas.map((linha) => linha.id), ['a4', 'a3']);
    assert.equal((await rota.chamar('/p1/historico?limite=0')).status, 400);
    assert.equal((await rota.chamar('/p1/historico?limite=201')).status, 400);
    assert.deepEqual((await rota.chamar('/nao-existe/historico')).corpo.data.linhas, []);
  } finally {
    rota.fechar();
  }
  const semLoja = await subirRota({ conta: { establishmentId: null, hasEstablishment: false } });
  try {
    assert.equal((await semLoja.chamar('/p1/historico')).status, 403);
  } finally {
    semLoja.fechar();
  }
});

test('3.5: sem o indice composto, a leitura cai para o filtro de igualdade e ordena em memoria', async () => {
  const banco = bancoComLog();
  const consultas = [];
  // Banco que recusa a consulta ordenada como o Firestore sem indice (FAILED_PRECONDITION).
  const semIndice = {
    collection: (nome) => {
      const colecao = banco.collection(nome);
      return {
        // B57-13k, item 35: o historico le usersAdmin para esconder as linhas do Admin.
        get: () => colecao.get(),
        doc: (id) => ({
          collection: (sub) => {
            const real = colecao.doc(id).collection(sub);
            return {
              where: (...filtro1) => ({
                where: (...filtro2) => {
                const consulta = real.where(...filtro1).where(...filtro2);
                return {
                  orderBy: () => ({ limit: () => ({ get: async () => { consultas.push('ordenada'); throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), { code: 9 }); } }) }),
                  limit: (limite) => { consultas.push(`igualdade:${limite}`); return consulta.limit(limite); },
                };
                },
              }),
            };
          },
        }),
      };
    },
  };
  const avisos = [];
  const repositorio = new FirestoreHistoricoDoProdutoRepository({ firestore: semIndice, logger: { warn: (mensagem) => avisos.push(mensagem) } });
  const historico = new HistoricoDoProduto({ repositorio });
  const resultado = await historico.listar({ ator: { establishmentId: LOJA, hasEstablishment: true }, produtoId: 'p1' });
  assert.deepEqual(consultas, ['ordenada', `igualdade:${LIMITE_SEM_INDICE}`]);
  assert.deepEqual(resultado.linhas.map((linha) => linha.id), ['a4', 'a3', 'a2', 'a1']);
  assert.equal(resultado.completo, true);
  assert.deepEqual(avisos, ['historico_do_produto_sem_indice']);
  assert.equal(faltaIndice({ code: 'failed-precondition' }), true);
  assert.equal(faltaIndice({ code: 7, message: 'PERMISSION_DENIED' }), false);
});

test('3.5: origem normalizada (manual do web e web; app e app; as outras seguem)', () => {
  assert.equal(origemNormalizada('manual'), 'web');
  assert.equal(origemNormalizada('app'), 'app');
  assert.equal(origemNormalizada('implantacao'), 'implantacao');
  assert.equal(origemNormalizada(''), null);
  assert.equal(origemNormalizada(undefined), null);
});

test('3.5: app.js monta /api/produtos com login e loja alvo do admin', () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /'\/api\/produtos',\s+createFirebaseAuthMiddleware\(\{ required: true \}\),\s+sessaoWeb,\s+lojaAlvoDoAdmin,\s+createProdutosRoutes/);
});

test('3.5 (decisao do Thay de 20/11): linha do ERP sai com quem "Linear", origem integrador e o motivo', async () => {
  const banco = bancoComLog();
  const rota = await subirRota({
    banco: new FirestoreEmMemoria({
      [`estabelecimentos/${LOJA}`]: { name: 'Loja 1' },
      [`estabelecimentos/${LOJA}/AcoesEquipe/l1`]: {
        em: new Date('2026-11-21T05:10:00Z'), quem: 'Linear', tela: 'integrador', acao: 'produto.unidade',
        alvo: { tipo: 'produto', id: 'p1', rotulo: 'Queijo por kg' },
        antes: { unitType: null }, depois: { unitType: 'ProductUnitType.quilograma' },
        origem: 'integrador', motivo: 'marcado como pesável no Linear',
      },
      [`estabelecimentos/${LOJA}/AcoesEquipe/l2`]: {
        em: new Date('2026-11-21T05:11:00Z'), quem: 'Linear', tela: 'integrador', acao: 'produto.saiuDoApp',
        alvo: { tipo: 'produto', id: 'p1', rotulo: 'Queijo por kg' },
        antes: { isActive: true }, depois: { isActive: false, offReasons: ['estoque_zerado'] },
        origem: 'integrador', motivo: '   ',
      },
    }),
  });
  void banco;
  try {
    const { status, corpo } = await rota.chamar('/p1/historico');
    assert.equal(status, 200);
    const [saiu, unidade] = corpo.data.linhas;
    assert.equal(unidade.quem, 'Linear');
    assert.equal(unidade.origem, 'integrador');
    assert.equal(unidade.motivo, 'marcado como pesável no Linear');
    assert.equal(saiu.motivo, null);
    assert.deepEqual(saiu.campos, [
      { campo: 'isActive', antes: true, depois: false },
      { campo: 'offReasons', antes: null, depois: ['estoque_zerado'] },
    ]);
  } finally {
    rota.fechar();
  }
});
