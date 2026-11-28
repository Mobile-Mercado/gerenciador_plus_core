// Cola 100, item 6: "Alterados hoje" da faixa da aba Integrador conta cada produto uma vez por dia
// (preco, estoque ou situacao mudados), no Core, pelos itens das cargas (IntegrationLogItems).
// Dados de exemplo. Falham com o codigo de antes: nao havia a contagem nem a rota.
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { AlteradosHoje } from '../src/application/integrador/AlteradosHoje.js';
import { contarAlterados, diaEmSaoPaulo, inicioDoDiaEmSaoPaulo, itemMudouOProduto } from '../src/domain/integrador/alteradosHoje.js';
import { FirestoreAlteradosHojeRepository } from '../src/infra/firebase/FirestoreAlteradosHojeRepository.js';
import { createIntegradorRoutes } from '../src/http/routes/integradorRoutes.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const AGORA = new Date('2026-11-28T15:00:00Z'); // 12:00 em Sao Paulo
const ITENS = 'estabelecimentos/loja-1/IntegrationLogItems';
const em = (iso) => new Date(iso);

function itensDeExemplo() {
  return {
    // Mesmo produto em tres arquivos de hoje: conta uma vez.
    [`${ITENS}/a1`]: { barCode: '789001', action: 'updated', stockFrom: 5, stockTo: 4, at: em('2026-11-28T12:00:00Z') },
    [`${ITENS}/a2`]: { barCode: '789001', action: 'updated', stockFrom: 4, stockTo: 3, at: em('2026-11-28T13:00:00Z') },
    [`${ITENS}/a3`]: { barCode: '789001', action: 'updated', priceFrom: 9.9, priceTo: 8.9, at: em('2026-11-28T14:00:00Z') },
    // Preco, situacao, lixeira, novo e promocao aplicada: cada um conta.
    [`${ITENS}/b1`]: { barCode: '789002', action: 'updated', priceFrom: 3, priceTo: 3.5, at: em('2026-11-28T12:10:00Z') },
    [`${ITENS}/c1`]: { barCode: '789003', action: 'updated', activeFrom: true, activeTo: false, at: em('2026-11-28T12:20:00Z') },
    [`${ITENS}/d1`]: { barCode: '789004', action: 'updated', trashedFrom: false, trashedTo: true, at: em('2026-11-28T12:30:00Z') },
    [`${ITENS}/e1`]: { barCode: '789005', action: 'created', at: em('2026-11-28T12:40:00Z') },
    [`${ITENS}/f1`]: { barCode: '789006', action: 'updated', promotionAction: 'applied', at: em('2026-11-28T12:50:00Z') },
    // Nao contam: so o motivo de estar fora do app, pesavel reenviado, promocao mantida, sem mudanca,
    // fora do catalogo e descartado.
    [`${ITENS}/g1`]: { barCode: '789007', action: 'updated', priceFrom: null, priceTo: null, stockFrom: null, stockTo: null, activeFrom: null, activeTo: null, at: em('2026-11-28T13:10:00Z') },
    [`${ITENS}/g2`]: { barCode: '789008', action: 'updated', stockFrom: 2, stockTo: 2, at: em('2026-11-28T13:20:00Z') },
    [`${ITENS}/g3`]: { barCode: '789009', action: 'unchanged', promotionAction: 'kept', at: em('2026-11-28T13:30:00Z') },
    [`${ITENS}/g4`]: { barCode: '789010', action: 'orphan', at: em('2026-11-28T13:40:00Z') },
    [`${ITENS}/g5`]: { barCode: '789011', action: 'ignored', promotionAction: 'discarded', at: em('2026-11-28T13:50:00Z') },
    // Ontem (antes da meia-noite de Sao Paulo, 03:00 UTC): nao conta.
    [`${ITENS}/h1`]: { barCode: '789012', action: 'updated', priceFrom: 1, priceTo: 2, at: em('2026-11-28T02:59:59Z') },
    // Outra loja: nao conta.
    'estabelecimentos/loja-2/IntegrationLogItems/z1': { barCode: '789013', action: 'created', at: em('2026-11-28T12:00:00Z') },
  };
}

function montar({ pagina } = {}) {
  const banco = new FirestoreEmMemoria(itensDeExemplo());
  const repositorio = new FirestoreAlteradosHojeRepository({ firestore: banco, paraData: (data) => data, ...(pagina ? { pagina } : {}) });
  let agora = AGORA;
  const alteradosHoje = new AlteradosHoje({ repositorio, clock: () => agora });
  return { banco, alteradosHoje, mudarHora: (nova) => { agora = nova; } };
}

test('Cola 100: dia de Sao Paulo comeca as 03:00 UTC', () => {
  assert.equal(diaEmSaoPaulo(new Date('2026-11-28T02:59:59Z')), '2026-11-27');
  assert.equal(diaEmSaoPaulo(new Date('2026-11-28T03:00:00Z')), '2026-11-28');
  assert.equal(inicioDoDiaEmSaoPaulo(AGORA).toISOString(), '2026-11-28T03:00:00.000Z');
});

test('Cola 100: cada produto conta uma vez; motivo, pesavel, promocao mantida e sem mudanca nao contam', () => {
  const itens = Object.values(itensDeExemplo());
  assert.equal(itemMudouOProduto({ action: 'updated', priceFrom: null, priceTo: 5 }), false);
  assert.equal(itemMudouOProduto({ action: 'updated', stockFrom: 0, stockTo: 3 }), true);
  assert.equal(itemMudouOProduto({ action: 'updated', promotionAction: 'removed' }), true);
  assert.equal(itemMudouOProduto({ action: 'updated', promotionAction: 'kept' }), false);
  assert.equal(itemMudouOProduto(null), false);
  // Todos os itens de exemplo (inclusive ontem e outra loja): 789001..789006, 789012 e 789013.
  assert.equal(contarAlterados(itens), 8);
});

test('Cola 100: so os itens de hoje da loja, em paginas, e o resultado guardado por 60 s', async () => {
  const { banco, alteradosHoje, mudarHora } = montar({ pagina: 3 });
  assert.deepEqual(await alteradosHoje.contar({ lojaId: 'loja-1' }), { dia: '2026-11-28', alterados: 6 });
  const leituras = banco.leituras;
  assert.ok(leituras >= 5, 'leu em paginas de 3');
  await alteradosHoje.contar({ lojaId: 'loja-1' });
  assert.equal(banco.leituras, leituras, 'segunda pergunta no mesmo minuto nao rele');
  mudarHora(new Date(AGORA.getTime() + 61_000));
  await alteradosHoje.contar({ lojaId: 'loja-1' });
  assert.ok(banco.leituras > leituras, 'depois de 60 s rele');
  assert.deepEqual(await alteradosHoje.contar({ lojaId: 'loja-2' }), { dia: '2026-11-28', alterados: 1 });
});

test('Cola 100: GET /api/integrador/alterados-hoje pela conta, com a permissao de ver logs', async () => {
  const { alteradosHoje } = montar();
  const contas = {
    'uid-dono': { hasEstablishment: true, establishmentId: 'loja-1', permissions: { isAdmin: true, keys: [] } },
    'uid-func': { hasEstablishment: true, establishmentId: 'loja-1', permissions: { isAdmin: false, keys: ['requests.view'] } },
    'uid-logs': { hasEstablishment: true, establishmentId: 'loja-1', permissions: { isAdmin: false, keys: ['logs.view'] } },
  };
  const { requirePermission, accountForRequest } = createPermissionGuard({
    accessRepository: { findAccountByClaims: async ({ uid }) => contas[uid] || { hasEstablishment: false } },
  });
  const app = express();
  app.use((request, _response, next) => { request.auth = { uid: request.headers['x-uid'], exp: 9999999999 }; next(); });
  app.use('/api/integrador', createIntegradorRoutes({ alteradosHoje, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const chamar = async (uid) => {
    const r = await fetch(`http://127.0.0.1:${servidor.address().port}/api/integrador/alterados-hoje`, { headers: { 'x-uid': uid } });
    return { status: r.status, corpo: await r.json() };
  };
  try {
    assert.deepEqual(await chamar('uid-dono'), { status: 200, corpo: { data: { dia: '2026-11-28', alterados: 6 } } });
    assert.equal((await chamar('uid-logs')).status, 200);
    assert.equal((await chamar('uid-func')).status, 403);
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});

test('Cola 100: a rota esta ligada no app com login, sessao e loja alvo do Admin', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const trecho = app.slice(app.indexOf("'/api/integrador'"), app.indexOf('createIntegradorRoutes({'));
  assert.ok(trecho.includes('createFirebaseAuthMiddleware({ required: true })'));
  assert.ok(trecho.includes('sessaoWeb'));
  assert.ok(trecho.includes('lojaAlvoDoAdmin'));
  const servidor = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(servidor, /alteradosHoje: new AlteradosHoje\(\{ repositorio: new FirestoreAlteradosHojeRepository\(\{ firestore \}\) \}\)/);
});
