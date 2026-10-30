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

// Rotas da propria loja (cola RP-7): conta pelo uid do token, com o guarda de permissao de verdade.
const CONTAS = {
  'uid-dono': { establishmentId: 'loja-gs', permissions: { isAdmin: true, groupId: null, keys: [] } },
  'uid-func-sem': { establishmentId: 'loja-gs', permissions: { isAdmin: false, groupId: 'g-pedidos', keys: ['requests.view'] } },
  'uid-func-com': { establishmentId: 'loja-gs', permissions: { isAdmin: false, groupId: 'g-ajustes', keys: ['settings.edit'] } },
  'uid-outra': { establishmentId: 'loja-outra', permissions: { isAdmin: true, groupId: null, keys: [] } },
};

async function comRotaDaLoja(usar) {
  const { default: express } = await import('express');
  const { createEntregaDaLojaRoutes } = await import('../src/http/routes/entregaDaLojaRoutes.js');
  const { createPermissionGuard } = await import('../src/http/middlewares/requirePermission.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { banco, entrega } = montar();
  banco.docs.set('estabelecimentos/loja-outra', { name: 'Outra', deliveryInfo: { valuePerKm: 9 }, scheduling: { contracted: true, enabled: false } });
  const { requirePermission, accountForRequest } = createPermissionGuard({
    accessRepository: { findAccountByClaims: async ({ uid }) => ({ hasEstablishment: true, establishmentDocument: {}, ...CONTAS[uid] }) },
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: request.headers['x-uid'] }; next(); });
  app.use('/api/loja/entrega', createEntregaDaLojaRoutes({ entregaDaLoja: entrega, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/loja/entrega`;
  const ler = (uid) => fetch(base, { headers: { 'x-uid': uid } });
  const patch = (uid, corpo) => fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-uid': uid }, body: JSON.stringify(corpo) });
  try {
    await usar({ ler, patch, banco });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

test('rota da loja GET /api/loja/entrega: a entrega da loja da conta, no mesmo formato do Admin', async () => {
  await comRotaDaLoja(async ({ ler }) => {
    const dono = await (await ler('uid-dono')).json();
    assert.equal(dono.data.lojaId, 'loja-gs');
    assert.equal(dono.data.minimumPriceCart, 20);
    assert.equal(dono.data.openingHours.length, 7);
    assert.equal((await (await ler('uid-func-sem')).json()).data.lojaId, 'loja-gs', 'ler nao pede permissao de gravar');
    const outra = await (await ler('uid-outra')).json();
    assert.equal(outra.data.lojaId, 'loja-outra');
    assert.equal(outra.data.deliveryInfo.valuePerKm, 9);
  });
});

test('rota da loja PATCH /api/loja/entrega: dono grava; funcionario sem settings.edit 403; outra loja so a dela', async () => {
  await comRotaDaLoja(async ({ patch, banco }) => {
    const dono = await patch('uid-dono', { deliveryInfo: { valuePerKm: 3, weekDaysDelivery: janelasDaTela() }, openingHours: dias() });
    assert.equal(dono.status, 200);
    const resposta = (await dono.json()).data;
    assert.equal(resposta.deliveryInfo.valuePerKm, 3);
    assert.equal(resposta.deliveryInfo.weekDaysDelivery[0].customIntervals.length, 2);
    assert.equal(banco.dados('estabelecimentos/loja-gs').deliveryInfo.weekDaysDelivery.length, 7);

    const semPermissao = await patch('uid-func-sem', { deliveryInfo: { valuePerKm: 7 } });
    assert.equal(semPermissao.status, 403);
    const erro = (await semPermissao.json()).error;
    assert.equal(erro.code, 'permission_denied');
    assert.equal(erro.key, 'settings.edit');
    assert.equal((await patch('uid-func-com', { deliveryInfo: { valuePerKm: 4 } })).status, 200);
    assert.equal(banco.dados('estabelecimentos/loja-gs').deliveryInfo.valuePerKm, 4);

    // A outra loja grava so a dela; a loja-gs fica como estava.
    assert.equal((await patch('uid-outra', { deliveryInfo: { valuePerKm: 11 } })).status, 200);
    assert.equal(banco.dados('estabelecimentos/loja-outra').deliveryInfo.valuePerKm, 11);
    assert.equal(banco.dados('estabelecimentos/loja-gs').deliveryInfo.valuePerKm, 4);

    // As mesmas validacoes do Admin.
    assert.equal((await patch('uid-dono', { deliveryInfo: { campoInventado: 1 } })).status, 400);
    assert.equal((await patch('uid-dono', { deliveryInfo: { weekDaysDelivery: janelasDaTela().slice(0, 6) } })).status, 400);
    const sobreposta = await patch('uid-dono', { deliveryInfo: { weekDaysDelivery: janelasDaTela((weekday) => (weekday === 1
      ? { customIntervals: [janela('08:00', '12:00'), janela('11:00', '14:00')] } : {})) } });
    assert.equal(sobreposta.status, 400);
    assert.equal((await patch('uid-dono', { deliveryInfo: { minimumDeliveryTimeInMinutes: 90 } })).status, 400, 'prazo minimo maior que o gravado');
  });
});

test('rota da loja: "Contratado" so pelo Admin; o mesmo valor passa e o agendamento so liga contratado', async () => {
  await comRotaDaLoja(async ({ patch, banco }) => {
    // loja-gs: contracted false.
    const contratar = await patch('uid-dono', { scheduling: { contracted: true } });
    assert.equal(contratar.status, 403);
    assert.equal((await contratar.json()).error.code, 'agendamento_contrato_so_admin');
    assert.equal(banco.dados('estabelecimentos/loja-gs').scheduling.contracted, false);
    assert.equal((await patch('uid-dono', { scheduling: { contracted: true, enabled: true } })).status, 403);
    assert.equal((await patch('uid-dono', { scheduling: { enabled: true } })).status, 409, 'sem contrato nao liga');
    const mesmo = await patch('uid-dono', { scheduling: { contracted: false }, minimumPriceCart: 25 });
    assert.equal(mesmo.status, 200, 'o mesmo valor gravado passa');
    assert.equal(banco.dados('estabelecimentos/loja-gs').minimumPriceCart, 25);
    assert.equal(Object.keys(banco.escritas.at(-1).dados).includes('scheduling.contracted'), false, 'e nao grava o contrato');

    // loja-outra: contracted true; liga e desliga, mas nao descontrata.
    assert.equal((await patch('uid-outra', { scheduling: { enabled: true } })).status, 200);
    assert.deepEqual(banco.dados('estabelecimentos/loja-outra').scheduling, { contracted: true, enabled: true });
    assert.equal((await patch('uid-outra', { scheduling: { contracted: false } })).status, 403);
    assert.equal((await patch('uid-outra', { scheduling: { contracted: true, enabled: false } })).status, 200);
    assert.deepEqual(banco.dados('estabelecimentos/loja-outra').scheduling, { contracted: true, enabled: false });
  });
});

// Janelas por dia como o app grava (mobile_core weekday_delivery_adapter.dart): Timestamp em
// 01/01/0001, hora de Sao Paulo (-3 h). No banco em memoria, Date.
const ANO_1 = -62135596800000;
const ano1 = (hora, minuto = 0) => new Date(ANO_1 + ((hora + 3) * 60 + minuto) * 60000);
const diaDoApp = (weekday) => ({
  weekday,
  canDelivery: weekday !== 7,
  initTime: ano1(8),
  endTime: ano1(20),
  interval: 4,
  maxSchedulesPerTime: 4,
  scheduleIntervalType: 'hours',
  customIntervals: weekday === 1 ? [
    { canDelivery: true, maxSchedulesPerTime: 4, freight: null, init: ano1(8), end: ano1(12) },
    { canDelivery: true, maxSchedulesPerTime: 2, freight: 5.5, init: ano1(14), end: ano1(18) },
  ] : [],
});
const JANELAS_DO_APP = [1, 2, 3, 4, 5, 6, 7].map(diaDoApp);
// Minuto do dia como o getAvailablesSchedules le (available-schedules.ts, minuteOfDayOfTimestamp).
const minutoDoServidor = (instante) => {
  const dia = 24 * 60 * 60000;
  return Math.floor(((((instante.getTime() - 3 * 60 * 60000) % dia) + dia) % dia) / 60000);
};
const janelasDaTela = (mudar = () => ({})) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  canDelivery: weekday !== 7,
  initTime: '08:00',
  endTime: '20:00',
  interval: 4,
  maxSchedulesPerTime: 4,
  customIntervals: weekday === 1 ? [
    { init: '08:00', end: '12:00', freight: null, maxSchedulesPerTime: 4, canDelivery: true },
    { init: '14:00', end: '18:00', freight: 5.5, maxSchedulesPerTime: 2, canDelivery: true },
  ] : [],
  ...mudar(weekday),
}));
const janela = (init, end, canDelivery = true) => ({ init, end, freight: null, maxSchedulesPerTime: 1, canDelivery });

test('janelas por dia: o GET devolve weekDaysDelivery em HH:mm; nome antigo so sem o novo; sem lista, null', async () => {
  const { entrega } = montar({ deliveryInfo: { ...DELIVERY_INFO, weekDaysDelivery: JANELAS_DO_APP } });
  const lida = await entrega.ler('loja-gs');
  assert.deepEqual(lida.deliveryInfo.weekDaysDelivery[0], {
    weekday: 1, canDelivery: true, initTime: '08:00', endTime: '20:00', interval: 4, maxSchedulesPerTime: 4, scheduleIntervalType: 'hours',
    customIntervals: [
      { init: '08:00', end: '12:00', freight: null, maxSchedulesPerTime: 4, canDelivery: true },
      { init: '14:00', end: '18:00', freight: 5.5, maxSchedulesPerTime: 2, canDelivery: true },
    ],
  });
  assert.equal(lida.deliveryInfo.weekDaysDelivery[6].canDelivery, false);
  assert.equal(lida.deliveryInfo.fretePorBairro.centro, 4, 'o resto do deliveryInfo vem como esta');

  const antiga = montar({ deliveryInfo: { weekdaysDelivery: JANELAS_DO_APP } });
  const daAntiga = (await antiga.entrega.ler('loja-gs')).deliveryInfo;
  assert.equal(daAntiga.weekDaysDelivery.length, 7);
  assert.equal(Object.hasOwn(daAntiga, 'weekdaysDelivery'), false);
  assert.equal((await montar().entrega.ler('loja-gs')).deliveryInfo.weekDaysDelivery, null);
});

test('janelas por dia: o PATCH grava a lista inteira de uma vez, completa, no formato do app e do servidor', async () => {
  const comCampoDoApp = JANELAS_DO_APP.map((dia) => ({ ...dia, campoDoApp: `dia-${dia.weekday}` }));
  const { banco, entrega } = montar({ deliveryInfo: { ...DELIVERY_INFO, weekDaysDelivery: comCampoDoApp } });
  const resultado = await entrega.salvar('loja-gs', {
    deliveryInfo: {
      weekDaysDelivery: janelasDaTela((weekday) => {
        if (weekday === 1) {
          return { customIntervals: [
            { init: '19:00', end: '22:30', freight: 7, maxSchedulesPerTime: 3, canDelivery: true },
            { init: '08:00', end: '12:00', freight: null, maxSchedulesPerTime: 4, canDelivery: true },
          ] };
        }
        return weekday === 2 ? { initTime: '09:30', endTime: '17:00' } : {};
      }),
    },
  });
  const ultima = banco.escritas.at(-1);
  assert.deepEqual(Object.keys(ultima.dados).sort(), ['deliveryInfo.weekDaysDelivery', 'updatedAt'], 'uma gravacao so, a lista inteira');
  const loja = banco.dados('estabelecimentos/loja-gs');
  assert.deepEqual(loja.deliveryInfo.fretePorBairro, { centro: 4, praia: 9 });
  const [segunda, terca] = loja.deliveryInfo.weekDaysDelivery;
  assert.equal(loja.deliveryInfo.weekDaysDelivery.length, 7);
  assert.equal(segunda.campoDoApp, 'dia-1', 'campo do dia que a tela nao conhece fica');
  assert.equal(segunda.initTime.getTime(), comCampoDoApp[0].initTime.getTime(), 'horario sem mudanca fica com o mesmo instante');
  assert.deepEqual(
    segunda.customIntervals.map((item) => [minutoDoServidor(item.init), minutoDoServidor(item.end), item.freight, item.maxSchedulesPerTime]),
    [[8 * 60, 12 * 60, null, 4], [19 * 60, 22 * 60 + 30, 7, 3]],
    'janelas na ordem do horario',
  );
  assert.deepEqual(Object.keys(segunda.customIntervals[0]), ['canDelivery', 'maxSchedulesPerTime', 'freight', 'init', 'end']);
  assert.equal(minutoDoServidor(terca.initTime), 9 * 60 + 30);
  assert.equal(minutoDoServidor(terca.endTime), 17 * 60);
  assert.equal(terca.scheduleIntervalType, 'hours');
  assert.equal(resultado.antes['deliveryInfo.weekDaysDelivery'][1].initTime, '08:00');
  assert.equal(resultado.entrega.deliveryInfo.weekDaysDelivery[1].initTime, '09:30');

  // Loja sem lista: todo dia nasce completo, com a data do app (01/01/0001).
  const nova = montar();
  await nova.entrega.salvar('loja-gs', { deliveryInfo: { weekDaysDelivery: janelasDaTela() } });
  const dias = nova.banco.dados('estabelecimentos/loja-gs').deliveryInfo.weekDaysDelivery;
  assert.equal(dias[0].initTime.getTime(), ano1(8).getTime());
  assert.equal(dias[0].customIntervals[1].end.getTime(), ano1(18).getTime());
  dias.forEach((dia) => assert.deepEqual(Object.keys(dia).sort(),
    ['canDelivery', 'customIntervals', 'endTime', 'initTime', 'interval', 'maxSchedulesPerTime', 'scheduleIntervalType', 'weekday']));
});

test('janelas por dia: 7 dias, fim depois do inicio e janelas que entregam sem se cruzar', async () => {
  const { banco, entrega } = montar({ deliveryInfo: { ...DELIVERY_INFO, weekDaysDelivery: JANELAS_DO_APP } });
  const recusa = (weekDaysDelivery, codigo) => assert.rejects(
    entrega.salvar('loja-gs', { deliveryInfo: { weekDaysDelivery } }),
    (erro) => erro.code === codigo && erro.statusCode === 400,
  );
  await recusa(janelasDaTela().slice(0, 6), 'entrega_janelas_incompletas');
  await recusa(janelasDaTela((weekday) => (weekday === 7 ? { weekday: 1 } : {})), 'entrega_janelas_incompletas');
  await recusa(janelasDaTela((weekday) => (weekday === 3 ? { initTime: '20:00', endTime: '08:00' } : {})), 'entrega_janela_invalida');
  await recusa(janelasDaTela((weekday) => (weekday === 1 ? { customIntervals: [janela('12:00', '12:00')] } : {})), 'entrega_janela_invalida');
  await recusa(janelasDaTela((weekday) => (weekday === 1 ? { customIntervals: [janela('08:00', '12:00'), janela('11:00', '14:00')] } : {})),
    'entrega_janelas_sobrepostas');
  assert.deepEqual(banco.dados('estabelecimentos/loja-gs').deliveryInfo.weekDaysDelivery, JANELAS_DO_APP, 'recusa nao grava nada');

  // Dia sem entrega aceita horario invertido; janela desligada pode cruzar com outra.
  await entrega.salvar('loja-gs', { deliveryInfo: { weekDaysDelivery: janelasDaTela((weekday) => {
    if (weekday === 7) return { initTime: '20:00', endTime: '08:00' };
    return weekday === 1 ? { customIntervals: [janela('08:00', '12:00'), janela('11:00', '14:00', false)] } : {};
  }) } });
  assert.equal(banco.dados('estabelecimentos/loja-gs').deliveryInfo.weekDaysDelivery[0].customIntervals.length, 2);
});

test('rota PATCH /entrega: weekDaysDelivery so com os 7 dias e os campos do formato', async () => {
  await comRotaDaEntrega(async ({ patch, ler, banco }) => {
    const enviar = (mudar) => patch({ deliveryInfo: { weekDaysDelivery: janelasDaTela(mudar) } });
    assert.equal((await patch({ deliveryInfo: { weekDaysDelivery: janelasDaTela().slice(0, 6) } })).status, 400);
    assert.equal((await enviar((weekday) => (weekday === 2 ? { initTime: '8:00' } : {}))).status, 400);
    assert.equal((await enviar((weekday) => (weekday === 2 ? { extra: 1 } : {}))).status, 400);
    assert.equal((await enviar((weekday) => (weekday === 1 ? { customIntervals: [{ init: '08:00', end: '09:00' }] } : {}))).status, 400);
    assert.equal((await enviar((weekday) => (weekday === 1 ? { maxSchedulesPerTime: 0 } : {}))).status, 400);
    assert.equal(banco.dados('estabelecimentos/loja-gs').deliveryInfo.weekDaysDelivery, undefined);
    const ok = await patch({ deliveryInfo: { weekDaysDelivery: janelasDaTela(), valuePerKm: 2 } });
    assert.equal(ok.status, 200);
    const lida = (await ler()).data.deliveryInfo;
    assert.equal(lida.weekDaysDelivery[0].customIntervals[1].freight, 5.5);
    assert.equal(lida.valuePerKm, 2);
  });
});
