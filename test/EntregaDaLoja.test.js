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
  assert.equal(lida.pedidoPertoDeFechar, null);

  await assert.rejects(entrega.salvar('loja-gs', { openingHours: dias().slice(0, 6) }), (erro) => erro.code === 'entrega_horarios_incompletos');
  await assert.rejects(
    entrega.salvar('loja-gs', { openingHours: dias((weekday) => (weekday === 2 ? { openingHours: '21:00' } : {})) }),
    (erro) => erro.code === 'entrega_horario_invalido',
  );
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
