// Cola do Thay B57-03 (18/11), D1 e D2, e B57-03c (19/11), item 8: aba "Alertas" do Admin com as
// conferencias automaticas so dos itens 3, 6 e 14 do checklist. Cada conferencia so le, abre o
// alerta quando falha e o fecha quando volta ao normal. Os outros itens ficam em "Conferidos por
// alguem da equipe", com "Conferi agora", que grava quem e quando.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AlertasDoAdmin,
  COLECAO_DE_ALERTAS,
  INTERVALO_ENTRE_CONFERENCIAS_MS,
  ITENS_DO_CHECKLIST,
} from '../src/application/admin/AlertasDoAdmin.js';
import {
  conferenciaDaSafrapay,
  conferenciaDosLogins,
  conferenciaDosSites,
  conferenciasDoChecklist,
} from '../src/application/admin/ConferenciasDoChecklist.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const AGORA = new Date('2026-11-19T17:30:00Z');
const MIN = 60 * 1000;
const antes = (minutos) => new Date(AGORA.getTime() - minutos * MIN);

function alertasCom(banco, conferencias, relogio = { agora: AGORA.getTime() }) {
  return new AlertasDoAdmin({ firestore: banco, conferencias, clock: () => relogio.agora });
}

test('D2: conferencia que falha abre o alerta; de novo, atualiza o mesmo; voltando ao normal, fecha sozinha', async () => {
  const banco = new FirestoreEmMemoria({});
  let resultado = { ok: false, alertas: [{ alcance: { tipo: 'todas' }, titulo: 'Sites fora do ar', texto: 'Admin respondeu 503.', detalhes: [] }] };
  const relogio = { agora: AGORA.getTime() };
  const alertas = alertasCom(banco, { sites: async () => resultado }, relogio);

  await alertas.conferir();
  let lista = await alertas.listar('abertos');
  assert.equal(lista.abertos, 1);
  assert.equal(lista.alertas[0].titulo, 'Sites fora do ar');
  assert.equal(lista.alertas[0].item, 14);
  assert.equal(lista.alertas[0].abertoEm, AGORA.toISOString());

  // Antes de 10 minutos, nao confere de novo.
  resultado = { ok: true };
  relogio.agora += INTERVALO_ENTRE_CONFERENCIAS_MS - 1;
  await alertas.conferir();
  assert.equal((await alertas.listar('abertos')).abertos, 1);

  // Ainda falhando: o mesmo alerta, com o texto novo e a hora de abertura de antes.
  resultado = { ok: false, alertas: [{ alcance: { tipo: 'todas' }, titulo: 'Sites fora do ar', texto: 'Admin respondeu 502.' }] };
  relogio.agora += 1;
  await alertas.conferir();
  lista = await alertas.listar('todos');
  assert.equal(lista.alertas.length, 1);
  assert.equal(lista.alertas[0].texto, 'Admin respondeu 502.');
  assert.equal(lista.alertas[0].abertoEm, AGORA.toISOString());

  // Voltou: fecha sozinho.
  resultado = { ok: true };
  await alertas.conferir({ forcar: true });
  lista = await alertas.listar('resolvidos');
  assert.equal(lista.abertos, 0);
  assert.equal(lista.alertas[0].situacao, 'resolvido');
  assert.equal(lista.alertas[0].resolvidoPor, 'sozinho');
});

test('D1: "Marcar como resolvido" grava quem e quando; a conferencia que ainda falha abre um alerta novo', async () => {
  const banco = new FirestoreEmMemoria({});
  const alertas = alertasCom(banco, { sites: async () => ({ ok: false, alertas: [{ titulo: 'Sites fora do ar', texto: 'x' }] }) });
  await alertas.conferir();
  const [aberto] = (await alertas.listar('abertos')).alertas;
  const resolvido = await alertas.resolver(aberto.id, { uid: 'u1', email: 'thay@exemplo.com', nome: 'Thay' });
  assert.equal(resolvido.situacao, 'resolvido');
  assert.equal(resolvido.resolvidoPor, 'Thay');
  assert.equal(resolvido.resolvidoEm, AGORA.toISOString());
  await assert.rejects(alertas.resolver('nao-existe', {}), (erro) => erro.statusCode === 404);

  await alertas.conferir({ forcar: true });
  const lista = await alertas.listar('todos');
  assert.equal(lista.alertas.length, 2);
  assert.equal(lista.abertos, 1);
});

test('D1: conferencias em dois grupos; so 3, 6 e 14 conferidos sozinhos; "Conferi agora" grava quem e quando', async () => {
  const banco = new FirestoreEmMemoria({});
  const alertas = alertasCom(banco, conferenciasDoChecklist({ firestore: banco, buscar: async () => ({ status: 200 }) }));
  let grupos = await alertas.listaDeConferencias();
  assert.deepEqual(grupos.sozinhos.map((linha) => linha.item), [3, 6, 14]);
  assert.equal(grupos.sozinhos[0].situacao, null, 'ainda sem conferencia');
  assert.equal(grupos.daEquipe.length, 17);
  assert.ok(grupos.daEquipe.some((linha) => linha.item === 1), 'item 1 (sim) ainda sem conferencia automatica');
  assert.equal(ITENS_DO_CHECKLIST.length, 20);

  await alertas.conferir();
  grupos = await alertas.listaDeConferencias();
  assert.deepEqual(grupos.sozinhos.map((linha) => [linha.item, linha.situacao, linha.ultimaEm]), [
    [3, 'ok', AGORA.toISOString()], [6, 'ok', AGORA.toISOString()], [14, 'ok', AGORA.toISOString()],
  ]);

  const feito = await alertas.conferiAgora('regioes-do-sms', { uid: 'u1', email: 'thay@exemplo.com', nome: 'Thay' });
  assert.deepEqual(feito, { chave: 'regioes-do-sms', conferidoEm: AGORA.toISOString(), conferidoPor: 'Thay' });
  grupos = await alertas.listaDeConferencias();
  const regioes = grupos.daEquipe.find((linha) => linha.chave === 'regioes-do-sms');
  assert.equal(regioes.conferidoPor, 'Thay');
  assert.equal(regioes.conferidoEm, AGORA.toISOString());
  await assert.rejects(alertas.conferiAgora('sites', {}), (erro) => erro.statusCode === 404, 'automatico nao');
  await assert.rejects(alertas.conferiAgora('xyz', {}), (erro) => erro.statusCode === 404);
});

test('D2, item 3: abre com 5 ou mais tentativas falhando e metade ou mais; cancelada nao conta', async () => {
  const registros = {};
  let n = 0;
  const tentar = (etapas, { metodo = 'telefone', erro = 'billing-not-enabled', minutos = 10 } = {}) => {
    n += 1;
    etapas.forEach((etapa) => {
      registros[`LoginAttempts/r${n}-${etapa}`] = { tentativa: `t${n}`, metodo, etapa, erro: etapa === 'falhou' ? erro : null, em: antes(minutos) };
    });
  };
  for (let i = 0; i < 5; i += 1) tentar(['pediu_codigo', 'falhou']);
  for (let i = 0; i < 3; i += 1) tentar(['pediu_codigo', 'entrou']);
  for (let i = 0; i < 4; i += 1) tentar(['falhou'], { erro: 'google/canceled', metodo: 'google' });
  tentar(['falhou'], { minutos: 90 }); // fora da ultima hora
  const banco = new FirestoreEmMemoria(registros);

  const resultado = await conferenciaDosLogins({ firestore: banco })({ agora: AGORA });
  assert.equal(resultado.ok, false);
  assert.equal(resultado.alertas[0].titulo, 'SMS do login falhando');
  assert.equal(resultado.alertas[0].texto, '5 de 8 tentativas de entrar falharam na última hora. Motivo mais comum: billing-not-enabled.');
  assert.deepEqual(resultado.alertas[0].alcance, { tipo: 'todas' });

  const poucas = new FirestoreEmMemoria(Object.fromEntries(Object.entries(registros).filter(([caminho]) => !/r[45]-/.test(caminho))));
  assert.equal((await conferenciaDosLogins({ firestore: poucas })({ agora: AGORA })).ok, true, '3 falhas so');
  assert.equal(banco.escritas.length, 0, 'so le');
});

test('D2, item 6: pedidos online da SafraPay sem pagar, ou pago parado, abrem o alerta da loja', async () => {
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-a': { name: 'G&S Atacarejo' } });
  const loja = (id) => banco.collection('estabelecimentos').doc(id);
  const online = (paymentStatus) => ({ provider: 'safrapay', mode: 'online', paymentStatus });
  const pedidos = {
    a1: { companyReference: loja('loja-a'), createdAt: antes(60), currentPurchaseStatus: 'PurchaseStatus.waitingForOrderPayment', purchasePayment: online('paymentDenied') },
    a2: { companyReference: loja('loja-a'), createdAt: antes(50), currentPurchaseStatus: 'PurchaseStatus.waitingForOrderPayment', purchasePayment: online('waitingForPayment') },
    a3: { companyReference: loja('loja-a'), createdAt: antes(40), currentPurchaseStatus: 'PurchaseStatus.canceled', purchasePayment: online('paymentDenied') },
    // Fora: teste, pagamento na entrega, mais de 24 horas.
    teste: { companyReference: loja('loja-a'), createdAt: antes(10), isTest: true, purchasePayment: online('paid'), currentPurchaseStatus: 'PurchaseStatus.completed' },
    entrega: { companyReference: loja('loja-a'), createdAt: antes(10), purchasePayment: { provider: 'safrapay', mode: 'entrega', paymentStatus: 'paid' } },
    velho: { companyReference: loja('loja-a'), createdAt: antes(60 * 25), purchasePayment: online('paid'), currentPurchaseStatus: 'PurchaseStatus.completed' },
    // Loja B: pago e andou; e pago parado ha 45 minutos.
    b1: { companyReference: loja('loja-b'), createdAt: antes(90), purchasePayment: online('paid'), currentPurchaseStatus: 'PurchaseStatus.completed' },
    b2: { companyReference: loja('loja-b'), createdAt: antes(45), purchasePayment: online('paid'), currentPurchaseStatus: 'PurchaseStatus.waitingForOrderPayment' },
    b3: { companyReference: loja('loja-b'), createdAt: antes(10), purchasePayment: online('paid'), currentPurchaseStatus: 'PurchaseStatus.waitingForOrderPayment' },
  };
  for (const [id, pedido] of Object.entries(pedidos)) await banco.collection('PurchaseRequests').doc(id).set(pedido);
  const escritas = banco.escritas.length;

  const resultado = await conferenciaDaSafrapay({ firestore: banco })({ agora: AGORA });
  assert.equal(resultado.ok, false);
  const porLoja = Object.fromEntries(resultado.alertas.map((alerta) => [alerta.alcance.lojaId, alerta]));
  assert.deepEqual(porLoja['loja-a'].alcance, { tipo: 'loja', lojaId: 'loja-a', nome: 'G&S Atacarejo' });
  assert.equal(porLoja['loja-a'].texto, '3 pedidos tentaram pagar online nas últimas 24 horas e nenhum foi pago.');
  assert.equal(porLoja['loja-b'].texto, '1 pedido pago continua esperando o pagamento há mais de 30 minutos.');
  assert.deepEqual(porLoja['loja-b'].detalhes, ['Pedido b2']);
  assert.equal(banco.escritas.length, escritas, 'so le');

  const vazio = new FirestoreEmMemoria({});
  assert.deepEqual(await conferenciaDaSafrapay({ firestore: vazio })({ agora: AGORA }), { ok: true });
});

test('D2, item 14: os tres sites; fora do ar ou com erro abre o alerta', async () => {
  const pedidos = [];
  const tudoNoAr = conferenciaDosSites({ buscar: async (endereco) => { pedidos.push(endereco); return { status: 200 }; } });
  assert.deepEqual(await tudoNoAr(), { ok: true });
  assert.deepEqual(pedidos, ['https://mobilegerenciador.com.br/', 'https://mobilemercado.com.br/', 'https://gerenciadormobile.web.app/admin']);

  const umFora = conferenciaDosSites({
    buscar: async (endereco) => {
      if (endereco.includes('mobilemercado')) throw new Error('getaddrinfo');
      return { status: endereco.includes('admin') ? 503 : 200 };
    },
  });
  const resultado = await umFora();
  assert.equal(resultado.ok, false);
  assert.equal(resultado.alertas[0].titulo, 'Sites fora do ar');
  assert.equal(resultado.alertas[0].texto, 'mobilemercado.com.br não respondeu. Admin respondeu 503.');
});

test('D1: rotas /api/admin/alertas atras da barreira de admin', async () => {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const banco = new FirestoreEmMemoria({});
  const alertasDoAdmin = alertasCom(banco, { sites: async () => ({ ok: false, alertas: [{ titulo: 'Sites fora do ar', texto: 'x' }] }) });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', (request, _response, next) => { request.auth = { uid: 'u1', email: 'thay@exemplo.com', name: 'Thay' }; next(); }, createAdminRoutes({ alertasDoAdmin }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/alertas`;
  try {
    const lista = (await (await fetch(`${base}?lista=abertos`)).json()).data;
    assert.equal(lista.abertos, 1, 'abrir a aba roda a conferencia');
    assert.deepEqual(lista.conferencias.sozinhos.map((linha) => linha.item), [14]);
    assert.equal((await (await fetch(`${base}/abertos`)).json()).data.abertos, 1);
    const resolvido = await fetch(`${base}/${lista.alertas[0].id}/resolver`, { method: 'POST' });
    assert.equal((await resolvido.json()).data.resolvidoPor, 'Thay');
    const conferi = await fetch(`${base}/conferencias/apple/conferi`, { method: 'POST' });
    assert.equal((await conferi.json()).data.conferidoPor, 'Thay');
    assert.ok(banco.escritas.every((escrita) => escrita.caminho.startsWith(`${COLECAO_DE_ALERTAS}/`) || escrita.caminho.startsWith('conferenciasDoAdmin/')), 'grava so nas colecoes da aba');
  } finally {
    servidor.close();
  }
});
