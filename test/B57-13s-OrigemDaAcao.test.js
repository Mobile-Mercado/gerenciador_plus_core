import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { ImportProductsFromCsvUseCase } from '../src/application/implantacao/ImportProductsFromCsvUseCase.js';
import { ManageManagerData } from '../src/application/data/ManageManagerData.js';
import { cabecalhoDaOrigem, origemDoCabecalho } from '../src/domain/logs/origemDaAcao.js';
import { contaDoAdminNaLoja } from '../src/http/middlewares/lojaAlvoDoAdmin.js';
import { createDataRoutes } from '../src/http/routes/dataRoutes.js';
import { createImplantacaoRoutes } from '../src/http/routes/implantacaoRoutes.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-13s, item 39: o Core grava em cada registro de acao (Log da equipe e lotes) a tela de
// onde ela veio e o caminho dessa tela, como "Início > Incoerências > Resolver". Ninguem marca a mao: o
// painel manda o caminho da tela aberta no cabecalho X-Origem; as rotinas do Core gravam a delas.
// Registro antigo fica sem origem. A exibicao nos Logs espera mockup.
const ACOES = 'estabelecimentos/loja-1/AcoesEquipe';
const HISTORICO = 'estabelecimentos/loja-1/implantacaoGrenciador/historicoProdutos_1';

test('B57-13s item 39: o cabecalho vira { tipo, tela, caminho, rota }; cabecalho invalido nao grava origem', () => {
  const valor = cabecalhoDaOrigem({ rota: '/produtos/editar', caminho: ['Produtos', 'Editar produto'] });
  assert.deepEqual(origemDoCabecalho(valor), { tipo: 'web', tela: 'Editar produto', caminho: ['Produtos', 'Editar produto'], rota: '/produtos/editar' });
  assert.deepEqual(origemDoCabecalho(cabecalhoDaOrigem({ rota: '/admin/aparencias', caminho: ['Admin', 'Aparências'] })).tipo, 'admin');
  // Admin agindo na loja (X-Loja-Alvo) e sempre admin, venha de onde vier.
  assert.equal(origemDoCabecalho(cabecalhoDaOrigem({ rota: '/implantacao', caminho: ['Implantação'] }), { porAdmin: true }).tipo, 'admin');
  for (const invalido of [undefined, '', 'lixo', encodeURIComponent('{"caminho":[]}'), encodeURIComponent(JSON.stringify({ caminho: ['x'.repeat(200)] })), encodeURIComponent(JSON.stringify({ caminho: ['A'], rota: 'http://fora' }))]) {
    assert.equal(origemDoCabecalho(invalido), null, String(invalido));
  }
});

function montar() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Zero Grau' },
    [HISTORICO]: { pagina: 1, registros: [{ produtoId: 'p1', quem: 'conta@loja.test', acao: 'tags' }] },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Zero Grau', userReference: firestore.doc('Users/doc-dono') });
  const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore });
  const gateway = new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) });
  return { firestore, accessRepository, gateway };
}

async function servidor(firestore, accessRepository, gateway) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'uid-dono', email: 'conta@loja.test' }; next(); });
  app.use('/api/data', createDataRoutes({ manageManagerData: new ManageManagerData({ accessRepository, gateway }) }));
  app.use('/api/implantacao', createImplantacaoRoutes({
    importProductsFromCsvUseCase: new ImportProductsFromCsvUseCase({ firestore }),
    requirePermission: () => (_request, _response, next) => next(),
    implantationAdminMiddleware: (_request, _response, next) => next(),
    accountForRequest: (request) => accessRepository.findAccountByClaims({ uid: request.auth.uid }),
  }));
  const ouvindo = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${ouvindo.address().port}`;
  const chamar = (caminho, corpo, origem) => fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origem ? { 'X-Origem': origem } : {}) },
    body: JSON.stringify(corpo),
  });
  return { ouvindo, chamar };
}

test('B57-13s item 39: a acao e o lote gravados pelo painel levam a tela e o caminho; sem cabecalho, sem origem', async () => {
  const { firestore, accessRepository, gateway } = montar();
  const { ouvindo, chamar } = await servidor(firestore, accessRepository, gateway);
  const origem = cabecalhoDaOrigem({ rota: '/produtos/editar', caminho: ['Produtos', 'Editar produto'] });
  try {
    const acao = (id) => ({ operation: 'set', target: { path: `${ACOES}/${id}` }, data: { quem: 'conta@loja.test', acao: 'produto.editar', origem: 'manual' } });
    assert.equal((await chamar('/api/data/mutate', acao('com'), origem)).status, 200);
    assert.deepEqual(firestore.docs.get(`${ACOES}/com`).origemDaAcao, { tipo: 'web', tela: 'Editar produto', caminho: ['Produtos', 'Editar produto'], rota: '/produtos/editar' });
    assert.equal((await chamar('/api/data/mutate', acao('sem'))).status, 200);
    assert.equal('origemDaAcao' in firestore.docs.get(`${ACOES}/sem`), false);
    // O painel manda a origem forjada no corpo: vale a do cabecalho.
    assert.equal((await chamar('/api/data/mutate', { ...acao('forjada'), data: { ...acao('forjada').data, origemDaAcao: { tipo: 'admin' } } })).status, 200);
    assert.equal('origemDaAcao' in firestore.docs.get(`${ACOES}/forjada`), false);
    // Lote: so o registro novo leva a origem; o antigo fica sem.
    const lote = cabecalhoDaOrigem({ rota: '/produtos/categorizador', caminho: ['Produtos', 'Categorizador'] });
    assert.equal((await chamar('/api/data/mutate', {
      operation: 'set', target: { path: HISTORICO }, options: { merge: true },
      data: { pagina: 1, registros: [{ produtoId: 'p1', quem: 'conta@loja.test', acao: 'tags' }, { produtoId: 'p2', quem: 'conta@loja.test', acao: 'tags' }] },
    }, lote)).status, 200);
    const registros = firestore.docs.get(HISTORICO).registros;
    assert.equal('origemDaAcao' in registros[0], false);
    assert.equal(registros[1].origemDaAcao.tela, 'Categorizador');
    // Planilha importada: as linhas levam a origem da tela.
    const planilha = cabecalhoDaOrigem({ rota: '/implantacao', caminho: ['Implantação'] });
    const resposta = await chamar('/api/implantacao/importar-produtos', { establishmentId: 'loja-1', csvText: 'Nome;Preço;EAN\nCoca 2L;9,90;789001' }, planilha);
    await resposta.text();
    const linhas = [...firestore.docs.entries()].filter(([caminho, dados]) => caminho.startsWith(`${ACOES}/`) && dados.origem === 'implantacao').map(([, dados]) => dados);
    assert.ok(linhas.length > 0);
    assert.ok(linhas.every((linha) => linha.origemDaAcao?.tela === 'Implantação'));
  } finally {
    ouvindo.close();
  }
});

test('B57-13s item 39: o Admin agindo na loja grava a origem do tipo admin', async () => {
  const { firestore, gateway } = montar();
  await gateway.mutate({
    actor: contaDoAdminNaLoja('uid-admin', 'loja-1'),
    origem: cabecalhoDaOrigem({ rota: '/admin/implantacao', caminho: ['Admin', 'Implantação'] }),
    request: { operation: 'set', target: { path: `${ACOES}/admin` }, data: { quem: 'admin@plataforma.test', acao: 'produto.editar' } },
  });
  assert.equal(firestore.docs.get(`${ACOES}/admin`).origemDaAcao.tipo, 'admin');
});

test('B57-13s item 39: a rotina da promocao vencida grava a origem dela', async () => {
  const { createRequire } = await import('node:module');
  const exigir = createRequire(import.meta.url);
  const { registroDaRemocao } = exigir('../functions/promocaoVencida.js');
  const registro = registroDaRemocao({ produtoId: 'p1', produto: { name: 'Arroz', promotionalPrice: 5 }, FieldValue: { serverTimestamp: () => 'agora' } });
  assert.deepEqual(registro.origemDaAcao, { tipo: 'rotina', tela: 'removerPromocaoVencidaNightly', caminho: [], rota: null });
});
