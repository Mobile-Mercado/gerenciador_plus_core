import assert from 'node:assert/strict';
import test from 'node:test';
import { EntregaDaLoja } from '../src/application/admin/EntregaDaLoja.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Horarios gravados como o app grava: instante com data ficticia, em America/Sao_Paulo (-3 h).
const sp = (hora, minuto, weekday = 1) => new Date(Date.UTC(2000, 0, 2 + weekday, hora + 3, minuto));
const DIAS = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  isOpen: weekday !== 7,
  openingHours: sp(7, 0, weekday),
  closeHours: sp(20, 0, weekday),
  open: { hours: 7, minutes: 0 },
  close: { hours: 20, minutes: 0 },
  campoDoApp: `guardado-${weekday}`,
}));
const DELIVERY_INFO = {
  deliveryCalcType: 'DeliveryCalcType.distance',
  deliveryType: 'distance',
  fixedValue: 8,
  baseValue: 5,
  valuePerKm: 1.5,
  maximunDistance: 10,
  maximumDistance: 10,
  minimumDeliveryTimeInMinutes: 30,
  maximumDeliveryTimeInMinutes: 60,
  // Campo que a tela nao conhece: nunca pode sumir.
  fretePorBairro: { centro: 4, praia: 9 },
};

function montar(mudancas = {}) {
  const banco = new FirestoreEmMemoria({
    'estabelecimentos/loja-gs': {
      name: 'G&S', deliveryInfo: DELIVERY_INFO, minimumPriceCart: 20, openingHours: DIAS, scheduling: { contracted: false, enabled: false }, ...mudancas,
    },
  });
  const entrega = new EntregaDaLoja({ firestore: banco, serverTimestamp: () => new Date('2026-10-17T12:00:00Z'), paraTimestamp: (ms) => new Date(ms) });
  return { banco, entrega };
}

const dias = (mudar = () => ({})) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday, isOpen: weekday !== 7, openingHours: '07:00', closeHours: '20:00', ...mudar(weekday),
}));

test('campo nao enviado continua intacto: so o valor por km muda, o resto do deliveryInfo fica', async () => {
  const { banco, entrega } = montar();
  const resultado = await entrega.salvar('loja-gs', { deliveryInfo: { valuePerKm: 2 } });
  const loja = banco.dados('estabelecimentos/loja-gs');
  assert.deepEqual(loja.deliveryInfo, { ...DELIVERY_INFO, valuePerKm: 2 });
  assert.deepEqual(loja.deliveryInfo.fretePorBairro, { centro: 4, praia: 9 });
  assert.equal(loja.minimumPriceCart, 20);
  assert.equal(loja.openingHours[0].campoDoApp, 'guardado-1');
  // A gravacao e campo a campo: o mapa deliveryInfo nao e regravado.
  const ultima = banco.escritas.at(-1);
  assert.deepEqual(Object.keys(ultima.dados).sort(), ['deliveryInfo.valuePerKm', 'updatedAt']);
  assert.deepEqual(resultado.campos, ['deliveryInfo.valuePerKm']);
  assert.deepEqual(resultado.antes, { 'deliveryInfo.valuePerKm': 1.5 });
});

test('tipo de calculo e distancia maxima mantem os espelhos que o mapa ja tem, como o painel', async () => {
  const { banco, entrega } = montar();
  await entrega.salvar('loja-gs', { deliveryInfo: { deliveryCalcType: 'DeliveryCalcType.fixedValue', maximunDistance: 12 }, minimumPriceCart: 35 });
  const loja = banco.dados('estabelecimentos/loja-gs');
  assert.equal(loja.deliveryInfo.deliveryType, 'fixed');
  assert.equal(loja.deliveryInfo.maximumDistance, 12);
  assert.equal(loja.deliveryInfo.fixedValue, 8);
  assert.equal(loja.minimumPriceCart, 35);
  // Loja sem os espelhos nao ganha os campos.
  const semEspelho = montar({ deliveryInfo: { deliveryCalcType: 'DeliveryCalcType.distance', fixedValue: 3 } });
  await semEspelho.entrega.salvar('loja-gs', { deliveryInfo: { deliveryCalcType: 'DeliveryCalcType.fixedValue' } });
  assert.deepEqual(semEspelho.banco.dados('estabelecimentos/loja-gs').deliveryInfo, { deliveryCalcType: 'DeliveryCalcType.fixedValue', fixedValue: 3 });
});

test('horarios: os 7 dias; dia sem mudanca fica com o mesmo instante e o que o app guardou no dia fica', async () => {
  const { banco, entrega } = montar();
  await entrega.salvar('loja-gs', { openingHours: dias((weekday) => (weekday === 6 ? { closeHours: '14:30' } : {})) });
  const horarios = banco.dados('estabelecimentos/loja-gs').openingHours;
  assert.equal(horarios[0].openingHours.getTime(), sp(7, 0, 1).getTime());
  assert.equal(horarios[0].campoDoApp, 'guardado-1');
  assert.equal(horarios[5].closeHours.getTime(), sp(14, 30, 6).getTime());
  assert.deepEqual(horarios[5].close, { hours: 14, minutes: 30 });
  assert.equal(horarios[6].isOpen, false);
  assert.equal(banco.dados('estabelecimentos/loja-gs').deliveryInfo.fixedValue, 8, 'a entrega nao muda');

  const lida = await entrega.ler('loja-gs');
  assert.deepEqual(lida.openingHours[5], { weekday: 6, isOpen: true, openingHours: '07:00', closeHours: '14:30' });
  assert.equal(lida.pedidoPertoDeFechar, 'allow', 'sem o campo vale allow, como o getAutoSchedule');

  await assert.rejects(entrega.salvar('loja-gs', { openingHours: dias().slice(0, 6) }), (erro) => erro.code === 'entrega_horarios_incompletos');
  await assert.rejects(
    entrega.salvar('loja-gs', { openingHours: dias((weekday) => (weekday === 2 ? { openingHours: '21:00' } : {})) }),
    (erro) => erro.code === 'entrega_horario_invalido',
  );
});

test('pedido perto de fechar: deliveryInfo.afterClosingDelivery, sem tocar no resto da entrega', async () => {
  const { banco, entrega } = montar();
  await entrega.salvar('loja-gs', { deliveryInfo: { afterClosingDelivery: 'nextDay' } });
  const loja = banco.dados('estabelecimentos/loja-gs');
  assert.deepEqual(loja.deliveryInfo, { ...DELIVERY_INFO, afterClosingDelivery: 'nextDay' });
  assert.equal((await entrega.ler('loja-gs')).pedidoPertoDeFechar, 'nextDay');
  const desconhecido = montar({ deliveryInfo: { afterClosingDelivery: 'sempre' } });
  assert.equal((await desconhecido.entrega.ler('loja-gs')).pedidoPertoDeFechar, 'allow');
});

test('agendamento: so liga contratado; tirar o contrato desliga', async () => {
  const { banco, entrega } = montar();
  await assert.rejects(entrega.salvar('loja-gs', { scheduling: { enabled: true } }), (erro) => erro.code === 'agendamento_nao_contratado');
  await entrega.salvar('loja-gs', { scheduling: { contracted: true, enabled: true } });
  assert.deepEqual(banco.dados('estabelecimentos/loja-gs').scheduling, { contracted: true, enabled: true });
  await entrega.salvar('loja-gs', { scheduling: { contracted: false } });
  assert.deepEqual(banco.dados('estabelecimentos/loja-gs').scheduling, { contracted: false, enabled: false });
  await assert.rejects(entrega.salvar('loja-gs', {}), (erro) => erro.code === 'entrega_sem_mudancas');
  await assert.rejects(entrega.salvar('nao-existe', { minimumPriceCart: 1 }), (erro) => erro.code === 'loja_nao_encontrada');
});

test('rota PATCH /entrega: so campos conhecidos, e quem mudou e quando vai para o registro do Admin', async () => {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { createAdminAuditMiddleware } = await import('../src/http/middlewares/adminAudit.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { banco, entrega } = montar();
  const app = express();
  app.use(express.json());
  app.use('/api/admin', (request, _response, next) => { request.auth = { uid: 'uid-admin', email: 'admin@mobile.com' }; next(); },
    createAdminAuditMiddleware({ firestore: banco, serverTimestamp: () => new Date('2026-10-17T12:00:00Z') }),
    createAdminRoutes({ entregaDaLoja: entrega }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/estabelecimentos/loja-gs/entrega`;
  const patch = (corpo) => fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  try {
    assert.equal((await (await fetch(base)).json()).data.minimumPriceCart, 20);
    assert.equal((await patch({ deliveryInfo: { campoInventado: 1 } })).status, 400);
    assert.equal((await patch({ deliveryInfo: { afterClosingDelivery: 'sempre' } })).status, 400);
    assert.equal((await patch({ deliveryInfo: { fretePorBairro: {} } })).status, 400, 'o mapa por bairro nao entra pela rota');
    const ok = await patch({ deliveryInfo: { baseValue: 6 } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data.deliveryInfo.baseValue, 6);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const registros = [...banco.docs.entries()].filter(([caminho]) => caminho.startsWith('adminAuditLogs/')).map(([, dados]) => dados);
    const registro = registros.find((item) => item.acao === 'entrega');
    assert.equal(registro.uid, 'uid-admin');
    assert.ok(registro.em);
    assert.deepEqual(registro.lojas, ['loja-gs']);
    assert.deepEqual(registro.antes, { 'deliveryInfo.baseValue': 5 });
    assert.ok([...banco.docs.keys()].some((caminho) => caminho.startsWith('estabelecimentos/loja-gs/AdminAuditLogs/')));
  } finally {
    servidor.close();
  }
});

// Sobe as rotas do Admin com a entrega da loja montada e devolve o PATCH e o banco.
async function comRotaDaEntrega(usar, mudancas = {}) {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { banco, entrega } = montar(mudancas);
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRoutes({ entregaDaLoja: entrega }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/estabelecimentos/loja-gs/entrega`;
  const patch = (corpo) => fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  try {
    await usar({ patch, ler: () => fetch(base).then((resposta) => resposta.json()), banco });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

test('rota PATCH /entrega: openingHours em HH:mm passa; horario fora do formato e 400', async () => {
  await comRotaDaEntrega(async ({ patch, banco }) => {
    const ok = await patch({ openingHours: dias((weekday) => (weekday === 3 ? { openingHours: '08:30' } : {})) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data.openingHours[2].openingHours, '08:30');
    assert.deepEqual(banco.dados('estabelecimentos/loja-gs').openingHours[2].open, { hours: 8, minutes: 30 });
    for (const errado of ['8:30', '08h30', 'dd:dd', '08:30:00']) {
      const recusa = await patch({ openingHours: dias((weekday) => (weekday === 1 ? { closeHours: errado } : {})) });
      assert.equal(recusa.status, 400, errado);
    }
    assert.deepEqual(banco.dados('estabelecimentos/loja-gs').openingHours[0].close, { hours: 20, minutes: 0 }, 'a recusa nao grava');
  });
});

test('prazo minimo menor que o maximo e distancia incluida ate a maxima, contra o valor gravado', async () => {
  // Gravado: prazo 30 a 60 min, distancia maxima 10 km.
  const { banco, entrega } = montar();
  const recusa = (deliveryInfo, codigo) => assert.rejects(
    entrega.salvar('loja-gs', { deliveryInfo }),
    (erro) => erro.code === codigo && erro.statusCode === 400,
  );
  await recusa({ minimumDeliveryTimeInMinutes: 90, maximumDeliveryTimeInMinutes: 60 }, 'entrega_prazo_invalido');
  await recusa({ minimumDeliveryTimeInMinutes: 60 }, 'entrega_prazo_invalido');
  await recusa({ maximumDeliveryTimeInMinutes: 20 }, 'entrega_prazo_invalido');
  await recusa({ minimumDistance: 12 }, 'entrega_distancia_invalida');
  await recusa({ minimumDistance: 3, maximunDistance: 2 }, 'entrega_distancia_invalida');
  await recusa({ maximunDistance: 0, minimumDistance: 1 }, 'entrega_distancia_invalida');
  assert.deepEqual(banco.dados('estabelecimentos/loja-gs').deliveryInfo, DELIVERY_INFO, 'recusa nao grava nada');

  await entrega.salvar('loja-gs', { deliveryInfo: { minimumDeliveryTimeInMinutes: 45 } });
  await entrega.salvar('loja-gs', { deliveryInfo: { minimumDistance: 10 } });
  assert.equal(banco.dados('estabelecimentos/loja-gs').deliveryInfo.minimumDeliveryTimeInMinutes, 45);
  assert.equal(banco.dados('estabelecimentos/loja-gs').deliveryInfo.minimumDistance, 10);

  // Loja antiga com so maximumDistance: compara com ele.
  const antiga = montar({ deliveryInfo: { maximumDistance: 5 } });
  await assert.rejects(antiga.entrega.salvar('loja-gs', { deliveryInfo: { minimumDistance: 6 } }), (erro) => erro.code === 'entrega_distancia_invalida');
  // Sem o outro valor gravado, nao ha o que comparar.
  const vazia = montar({ deliveryInfo: {} });
  await vazia.entrega.salvar('loja-gs', { deliveryInfo: { minimumDeliveryTimeInMinutes: 500 } });
});
