import assert from 'node:assert/strict';
import test from 'node:test';
import { EntregaDaLoja } from '../src/application/admin/EntregaDaLoja.js';
import { AppDoClienteDaLoja } from '../src/application/loja/AppDoClienteDaLoja.js';
import { FormasDePagamento } from '../src/application/loja/FormasDePagamento.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Contrato da versao 55 (cola RP-13, parte A.1): funcoes do app, aparencia da Home, formas de
// pagamento e retirada na loja.
const LOJA = 'estabelecimentos/loja-1';
function montar(loja = {}, extras = {}) {
  const banco = new FirestoreEmMemoria({
    [LOJA]: {
      name: 'Loja 1',
      featureFlags: { promotions: true, banners: true, allBannersTypes: false },
      paymentMethods: [
        { id: 'credito', name: 'Cartão de crédito', isActive: true, order: 1, icon: null },
        { id: 'dinheiro', name: 'Dinheiro', isActive: true, order: 2, icon: null },
        { id: 'pix', name: 'Pix', isActive: false, order: 3, icon: null },
        { id: null, name: 'Vale', isActive: false, order: 4, icon: null },
      ],
      ...loja,
    },
    [`${LOJA}/paymentMethods/cartao`]: { name: 'Cartão de crédito/débito', isActive: true, cobradoEm: 'entrega' },
    'estabelecimentos/loja-2': { name: 'Loja 2' },
    ...extras,
  });
  const relogio = () => new Date('2026-10-21T12:00:00Z');
  return {
    banco,
    app: new AppDoClienteDaLoja({ firestore: banco, serverTimestamp: relogio }),
    formas: new FormasDePagamento({ firestore: banco, serverTimestamp: relogio }),
    entrega: new EntregaDaLoja({ firestore: banco, serverTimestamp: relogio, paraTimestamp: (ms) => new Date(ms), paraGeoPoint: (latitude, longitude) => ({ latitude, longitude }) }),
  };
}

test('app do cliente: padroes do contrato (so Resumo do mes ligado; Home 2, 2, 2, 2) e valor gravado fora da faixa vale o padrao', async () => {
  const { app } = montar({ aparenciaHome: { topo: 9, meio: 3, fim: '4', preposicaoBusca: 'pelo' }, featureFlags: { retirada: 'sim', cuponsFiscais: true } });
  assert.deepEqual(await app.ler('loja-1'), {
    lojaId: 'loja-1',
    featureFlags: { retirada: false, substituicao: false, resumoDoMes: true, cuponsFiscais: true, debito: false },
    aparenciaHome: { topo: 2, meio: 3, fim: 2, rodape: 2, preposicaoBusca: 'no' },
  });
});

test('app do cliente: cada chave gravada sozinha; promotions, banners e allBannersTypes ficam', async () => {
  const { banco, app } = montar();
  const resultado = await app.salvar('loja-1', { featureFlags: { retirada: true, resumoDoMes: false }, aparenciaHome: { fim: 4, rodape: 1, preposicaoBusca: 'na' } });
  const loja = banco.dados(LOJA);
  assert.deepEqual(loja.featureFlags, { promotions: true, banners: true, allBannersTypes: false, retirada: true, resumoDoMes: false });
  assert.deepEqual(loja.aparenciaHome, { fim: 4, rodape: 1, preposicaoBusca: 'na' });
  assert.deepEqual(resultado.app.aparenciaHome, { topo: 2, meio: 2, fim: 4, rodape: 1, preposicaoBusca: 'na' });
  assert.deepEqual(resultado.antes, {
    'featureFlags.retirada': false, 'featureFlags.resumoDoMes': true, 'aparenciaHome.fim': 2, 'aparenciaHome.rodape': 2, 'aparenciaHome.preposicaoBusca': 'no',
  });
  await assert.rejects(app.salvar('loja-1', {}), (erro) => erro.code === 'app_do_cliente_sem_mudancas');
  await assert.rejects(app.salvar('nao-existe', { featureFlags: { debito: true } }), (erro) => erro.code === 'loja_nao_encontrada');
});

test('debito: o Admin liberar liga o item debito do array e o documento debito; desliberar desliga os dois', async () => {
  const { banco, app } = montar();
  await app.salvar('loja-1', { featureFlags: { debito: true } });
  let loja = banco.dados(LOJA);
  const debito = loja.paymentMethods.find((item) => item?.id === 'debito');
  assert.deepEqual(debito, { id: 'debito', name: 'Cartão de débito', isActive: true, order: 5, icon: null });
  assert.equal(loja.paymentMethods.length, 5, 'os outros itens ficam como estavam');
  assert.deepEqual(banco.dados(`${LOJA}/paymentMethods/debito`), { name: 'Cartão de débito', isActive: true, cobradoEm: 'entrega' });
  await app.salvar('loja-1', { featureFlags: { debito: false } });
  loja = banco.dados(LOJA);
  assert.equal(loja.paymentMethods.find((item) => item?.id === 'debito').isActive, false);
  assert.equal(banco.dados(`${LOJA}/paymentMethods/debito`).isActive, false);
  assert.equal(loja.featureFlags.debito, false);
});

test('formas de pagamento: le o array e a subcolecao; credito e debito sem documento proprio caem no cartao de antes', async () => {
  const { formas } = montar();
  assert.deepEqual(await formas.ler('loja-1'), {
    lojaId: 'loja-1',
    debitoLiberado: false,
    formas: {
      pix: { ativa: false, cobradoEm: 'entrega' },
      credito: { ativa: true, cobradoEm: 'entrega' },
      debito: { ativa: false, cobradoEm: 'entrega' },
      dinheiro: { ativa: true, cobradoEm: 'entrega' },
    },
  });
});

test('formas de pagamento: grava o array e a subcolecao juntos, com o espelho cartao igual ao credito', async () => {
  const { banco, formas } = montar({ safrapay: { enabled: true, methods: { pix: false, creditcard: false } } });
  const lida = await formas.salvar('loja-1', { credito: { cobradoEm: 'ambos' }, pix: { ativa: true, cobradoEm: 'app' } });
  assert.deepEqual(lida.formas.credito, { ativa: true, cobradoEm: 'ambos' });
  assert.deepEqual(lida.formas.pix, { ativa: true, cobradoEm: 'app' });
  const loja = banco.dados(LOJA);
  assert.equal(loja.paymentMethods.find((item) => item?.id === 'pix').isActive, true);
  assert.deepEqual(loja.paymentMethods.find((item) => item?.name === 'Vale'), { id: null, name: 'Vale', isActive: false, order: 4, icon: null }, 'item desconhecido fica');
  assert.deepEqual(banco.dados(`${LOJA}/paymentMethods/credito`), { name: 'Cartão de crédito', isActive: true, cobradoEm: 'ambos' });
  assert.deepEqual(banco.dados(`${LOJA}/paymentMethods/cartao`), { name: 'Cartão de crédito', isActive: true, cobradoEm: 'ambos' }, 'espelho para o app 54');
  assert.deepEqual(banco.dados(`${LOJA}/paymentMethods/pix`), { name: 'Pix', isActive: true, cobradoEm: 'app' });

  await assert.rejects(formas.salvar('loja-1', { debito: { ativa: true } }), (erro) => erro.code === 'debito_nao_liberado' && erro.statusCode === 409);
  await assert.rejects(formas.salvar('loja-1', { dinheiro: { cobradoEm: 'app' } }), (erro) => erro.code === 'forma_cobranca_invalida');
  await assert.rejects(formas.salvar('loja-1', {}), (erro) => erro.code === 'formas_sem_mudancas');

  // Liberado pelo Admin, a loja liga e escolhe onde cobra.
  const liberada = montar({ featureFlags: { debito: true } });
  const comDebito = await liberada.formas.salvar('loja-1', { debito: { ativa: true, cobradoEm: 'entrega' } });
  assert.deepEqual(comDebito.formas.debito, { ativa: true, cobradoEm: 'entrega' });
  assert.equal(comDebito.debitoLiberado, true);
  assert.equal(liberada.banco.dados(LOJA).paymentMethods.find((item) => item?.id === 'debito').isActive, true);
});

// Horarios da retirada no formato de weekDaysDelivery, em HH:mm na tela.
const horarios = (mudar = () => ({})) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday, canDelivery: weekday !== 7, initTime: '09:00', endTime: '18:00', interval: 2, maxSchedulesPerTime: 5,
  customIntervals: weekday === 6 ? [{ init: '09:00', end: '12:00', freight: 7, maxSchedulesPerTime: 3, canDelivery: true }] : [],
  ...mudar(weekday),
}));

test('retirada: grava endereco, instrucoes, preparo e horarios (frete sempre null); a entrega mostra se esta ligada', async () => {
  const { banco, entrega } = montar({ featureFlags: { retirada: true } });
  const { entrega: lida, campos } = await entrega.salvar('loja-1', {
    retirada: {
      endereco: { street: ' Rua  A ', number: '10', city: 'Vitória', uf: 'es', zipCode: '29000-000', position: { latitude: -20.3, longitude: -40.3 } },
      instrucoes: '  Balcão  dos fundos ',
      tempoPreparoMin: 45,
      horarios: horarios(),
    },
  });
  assert.deepEqual(campos.sort(), ['retirada.endereco', 'retirada.horarios', 'retirada.instrucoes', 'retirada.tempoPreparoMin']);
  const gravada = banco.dados(LOJA).retirada;
  assert.deepEqual(gravada.endereco, {
    street: 'Rua A', number: '10', complement: null, neighborhood: null, city: 'Vitória', uf: 'ES', zipCode: '29000-000', position: { latitude: -20.3, longitude: -40.3 },
  });
  assert.equal(gravada.instrucoes, 'Balcão dos fundos');
  assert.equal(gravada.horarios.length, 7);
  assert.equal(gravada.horarios[5].customIntervals[0].freight, null, 'retirada nao tem frete');
  assert.equal(lida.retirada.ligada, true);
  assert.equal(lida.retirada.tempoPreparoMin, 45);
  assert.equal(lida.retirada.horarios[5].customIntervals[0].init, '09:00');
  assert.equal(lida.retirada.endereco.street, 'Rua A');

  // Sem horarios proprios (null): volta aos horarios da loja.
  await entrega.salvar('loja-1', { retirada: { horarios: null, endereco: null } });
  const depois = await entrega.ler('loja-1');
  assert.equal(depois.retirada.horarios, null);
  assert.equal(depois.retirada.endereco, null);
  assert.equal(banco.dados(LOJA).retirada.horarios, undefined);

  await assert.rejects(entrega.salvar('loja-1', { retirada: { endereco: { street: 'Rua A' } } }), (erro) => erro.code === 'retirada_endereco_incompleto');
  await assert.rejects(entrega.salvar('loja-1', { retirada: { horarios: horarios((weekday) => (weekday === 2 ? { initTime: '19:00' } : {})) } }),
    (erro) => erro.code === 'entrega_janela_invalida');
});

test('retirada desligada: a tela recebe ligada false e o padrao de 30 minutos de preparo', async () => {
  const { entrega } = montar();
  const { retirada } = await entrega.ler('loja-1');
  assert.deepEqual(retirada, { ligada: false, endereco: null, instrucoes: null, tempoPreparoMin: 30, horarios: null });
});

// ----- Rotas -----
async function comRotas(usar, loja = {}) {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { createEntregaDaLojaRoutes } = await import('../src/http/routes/entregaDaLojaRoutes.js');
  const { createFormasDePagamentoRoutes } = await import('../src/http/routes/formasDePagamentoRoutes.js');
  const { createPermissionGuard } = await import('../src/http/middlewares/requirePermission.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const contexto = montar(loja);
  const contas = {
    'uid-dono': { establishmentId: 'loja-1', permissions: { isAdmin: true, groupId: null, keys: [] } },
    'uid-func': { establishmentId: 'loja-1', permissions: { isAdmin: false, groupId: 'g', keys: ['requests.view'] } },
    'uid-outra': { establishmentId: 'loja-2', permissions: { isAdmin: true, groupId: null, keys: [] } },
  };
  const { requirePermission, accountForRequest } = createPermissionGuard({
    accessRepository: { findAccountByClaims: async ({ uid }) => ({ hasEstablishment: true, establishmentDocument: {}, ...contas[uid] }) },
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: request.headers['x-uid'] }; next(); });
  app.use('/api/admin', createAdminRoutes({ entregaDaLoja: contexto.entrega, appDoClienteDaLoja: contexto.app, formasDePagamento: contexto.formas }));
  app.use('/api/loja/entrega', createEntregaDaLojaRoutes({ entregaDaLoja: contexto.entrega, requirePermission, accountForRequest }));
  app.use('/api/loja/formas-de-pagamento', createFormasDePagamentoRoutes({ formasDePagamento: contexto.formas, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const chamar = (metodo, caminho, uid, corpo) => fetch(`${base}${caminho}`, {
    method: metodo, headers: { 'Content-Type': 'application/json', 'x-uid': uid || '' }, body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  try {
    await usar({ chamar, ...contexto });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

test('rota do Admin /app-do-cliente: so booleanos nos interruptores e os blocos na faixa', async () => {
  await comRotas(async ({ chamar, banco }) => {
    const caminho = '/api/admin/estabelecimentos/loja-1/app-do-cliente';
    assert.equal((await chamar('PATCH', caminho, null, { featureFlags: { retirada: 'true' } })).status, 400);
    assert.equal((await chamar('PATCH', caminho, null, { featureFlags: { promotions: false } })).status, 400, 'so as chaves do contrato');
    assert.equal((await chamar('PATCH', caminho, null, { aparenciaHome: { topo: 4 } })).status, 400);
    assert.equal((await chamar('PATCH', caminho, null, { aparenciaHome: { fim: 5 } })).status, 400);
    assert.equal((await chamar('PATCH', caminho, null, { aparenciaHome: { rodape: 3 } })).status, 400);
    assert.equal((await chamar('PATCH', caminho, null, { aparenciaHome: { preposicaoBusca: 'pelo' } })).status, 400);
    const ok = await chamar('PATCH', caminho, null, { featureFlags: { substituicao: true }, aparenciaHome: { topo: 3, fim: 4 } });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).data.aparenciaHome, { topo: 3, meio: 2, fim: 4, rodape: 2, preposicaoBusca: 'no' });
    assert.equal(banco.dados(LOJA).featureFlags.substituicao, true);
    assert.equal((await (await chamar('GET', caminho)).json()).data.featureFlags.substituicao, true);
  });
});

test('rotas da loja: a loja grava formas e retirada, mas nao liga a retirada nem o debito; outra loja so a dela', async () => {
  await comRotas(async ({ chamar, banco }) => {
    // Formas de pagamento
    assert.equal((await chamar('PATCH', '/api/loja/formas-de-pagamento', 'uid-func', { formas: { pix: { ativa: true } } })).status, 403);
    assert.equal((await chamar('PATCH', '/api/loja/formas-de-pagamento', 'uid-dono', { formas: { boleto: { ativa: true } } })).status, 400);
    assert.equal((await chamar('PATCH', '/api/loja/formas-de-pagamento', 'uid-dono', { formas: { debito: { ativa: true } } })).status, 409);
    const semGateway = await chamar('PATCH', '/api/loja/formas-de-pagamento', 'uid-dono', { formas: { pix: { ativa: true, cobradoEm: 'app' } } });
    assert.equal(semGateway.status, 400);
    assert.equal((await semGateway.json()).error.code, 'forma_sem_gateway');
    const pix = await chamar('PATCH', '/api/loja/formas-de-pagamento', 'uid-dono', { formas: { pix: { ativa: true, cobradoEm: 'entrega' } } });
    assert.equal(pix.status, 200);
    assert.deepEqual((await pix.json()).data.formas.pix, { ativa: true, cobradoEm: 'entrega' });
    assert.equal((await (await chamar('GET', '/api/loja/formas-de-pagamento', 'uid-func')).json()).data.formas.pix.ativa, true, 'ler nao pede chave');
    await chamar('PATCH', '/api/loja/formas-de-pagamento', 'uid-outra', { formas: { pix: { ativa: true } } });
    assert.equal(banco.dados('estabelecimentos/loja-2').paymentMethods[0].id, 'pix');
    assert.equal(banco.dados(LOJA).paymentMethods.length, 4, 'a loja-1 fica como estava');

    // Retirada pela rota da entrega: dados sim, interruptor nao.
    const dados = await chamar('PATCH', '/api/loja/entrega', 'uid-dono', { retirada: { instrucoes: 'Portão azul', tempoPreparoMin: 20, horarios: horarios() } });
    assert.equal(dados.status, 200);
    const retirada = (await dados.json()).data.retirada;
    assert.equal(retirada.instrucoes, 'Portão azul');
    assert.equal(retirada.ligada, false);
    assert.equal((await chamar('PATCH', '/api/loja/entrega', 'uid-dono', { retirada: { ligada: true } })).status, 400);
    assert.equal((await chamar('PATCH', '/api/loja/entrega', 'uid-dono', { featureFlags: { retirada: true } })).status, 400);
    assert.equal((await chamar('PATCH', '/api/loja/entrega', 'uid-dono', { retirada: { tempoPreparoMin: 2000 } })).status, 400);
    assert.equal((await chamar('PATCH', '/api/loja/entrega', 'uid-func', { retirada: { tempoPreparoMin: 10 } })).status, 403);
    assert.equal(banco.dados(LOJA).featureFlags.retirada, undefined);

    // Admin: mesma rota de entrega e formas pela loja escolhida.
    assert.equal((await chamar('PATCH', '/api/admin/estabelecimentos/loja-1/entrega', null, { retirada: { tempoPreparoMin: 15 } })).status, 200);
    assert.equal(banco.dados(LOJA).retirada.tempoPreparoMin, 15);
    const formasAdmin = await chamar('PATCH', '/api/admin/estabelecimentos/loja-1/formas-de-pagamento', null, { formas: { dinheiro: { ativa: false } } });
    assert.equal(formasAdmin.status, 200);
    assert.equal((await formasAdmin.json()).data.formas.dinheiro.ativa, false);
  });
});

test('BFF de dados: featureFlags e aparenciaHome so pelo Admin; retirada so pela rota da entrega', async () => {
  const { ManagerDataAccessPolicy } = await import('../src/infra/firebase/ManagerDataAccessPolicy.js');
  const { banco } = montar();
  const policy = new ManagerDataAccessPolicy({ firestore: banco });
  const actor = { uid: 'uid-dono', userId: 'loja-1', establishmentId: 'loja-1', hasEstablishment: true };
  const mudar = (data) => policy.assertMutation({ actor, mutation: { operation: 'update', target: { kind: 'document', path: LOJA }, data } });
  const recusa = (data, code) => assert.rejects(mudar(data), (erro) => erro.statusCode === 403 && erro.code === code);
  await recusa({ 'featureFlags.retirada': true }, 'campo_so_admin');
  await recusa({ featureFlags: { promotions: true } }, 'campo_so_admin');
  await recusa({ 'aparenciaHome.topo': 1 }, 'campo_so_admin');
  await recusa({ 'retirada.tempoPreparoMin': 5 }, 'campo_so_pela_rota');
  await recusa({ retirada: {} }, 'campo_so_pela_rota');
  await mudar({ name: 'Loja 1 nova' });
});

// Cola RP-33 (regra do Thay de 22/10): o lojista decide onde cada forma e cobrada; o app obedece;
// debito nunca e cobrado pelo app.
const GATEWAY_LIGADO = { safrapay: { enabled: true, methods: { pix: true, creditcard: true, debitcard: false } } };

test('RP-33: sem cobradoEm gravado vale o que o app faz hoje (G&S: gateway ligado, Pix e credito no app)', async () => {
  // Loja como a G&S: gateway ligado e nenhum documento de forma com cobradoEm.
  const { formas } = montar(GATEWAY_LIGADO, { [`${LOJA}/paymentMethods/cartao`]: { name: 'Cartão', isActive: true } });
  const lidas = (await formas.ler('loja-1')).formas;
  assert.equal(lidas.pix.cobradoEm, 'app');
  assert.equal(lidas.credito.cobradoEm, 'app');
  assert.equal(lidas.debito.cobradoEm, 'entrega');
  assert.equal(lidas.dinheiro.cobradoEm, 'entrega');
  // Sem gateway, tudo na entrega ou na retirada; o que esta gravado vale (menos no debito).
  const semGateway = montar({}, { [`${LOJA}/paymentMethods/cartao`]: { name: 'Cartão', isActive: true, cobradoEm: 'ambos' } });
  const sem = (await semGateway.formas.ler('loja-1')).formas;
  assert.equal(sem.pix.cobradoEm, 'entrega');
  assert.equal(sem.credito.cobradoEm, 'ambos');
  assert.equal(sem.debito.cobradoEm, 'entrega', 'debito nunca e cobrado pelo app');
});

test('RP-33: recusa "app" e "ambos" sem gateway, e no debito sempre', async () => {
  const semGateway = montar();
  for (const cobradoEm of ['app', 'ambos']) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(semGateway.formas.salvar('loja-1', { pix: { cobradoEm } }), (erro) => erro.code === 'forma_sem_gateway' && erro.statusCode === 400);
  }
  const comGateway = montar({ ...GATEWAY_LIGADO, featureFlags: { debito: true } });
  for (const cobradoEm of ['app', 'ambos']) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(comGateway.formas.salvar('loja-1', { debito: { ativa: true, cobradoEm } }), (erro) => erro.code === 'debito_so_presencial' && erro.statusCode === 400);
  }
  // Com gateway, Pix e credito aceitam "app" e "ambos".
  const salva = await comGateway.formas.salvar('loja-1', { pix: { ativa: true, cobradoEm: 'ambos' }, credito: { cobradoEm: 'app' } });
  assert.equal(salva.formas.pix.cobradoEm, 'ambos');
  assert.equal(salva.formas.credito.cobradoEm, 'app');
});

test('RP-33: com gateway, safrapay.methods e gravado pelo Core na mesma gravacao; sem gateway, nada', async () => {
  const { banco, formas } = montar(GATEWAY_LIGADO);
  await formas.salvar('loja-1', { pix: { ativa: true, cobradoEm: 'entrega' }, credito: { ativa: true, cobradoEm: 'ambos' } });
  assert.deepEqual(banco.dados(LOJA).safrapay.methods, { pix: false, creditcard: true, debitcard: false });
  assert.equal(banco.dados(LOJA).safrapay.enabled, true, 'o resto do mapa fica');
  // Forma desligada nao e cobrada no app.
  await formas.salvar('loja-1', { credito: { ativa: false } });
  assert.equal(banco.dados(LOJA).safrapay.methods.creditcard, false);
  // Loja sem gateway: o mapa safrapay nao e criado.
  const sem = montar();
  await sem.formas.salvar('loja-1', { pix: { ativa: true, cobradoEm: 'entrega' } });
  assert.equal('safrapay' in sem.banco.dados(LOJA), false);
});
