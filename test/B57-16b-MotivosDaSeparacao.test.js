import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { MotivosDaSeparacao } from '../src/application/loja/MotivosDaSeparacao.js';
import {
  MOTIVOS_PADRAO, chipDoMotivo, mesmoMotivo, montarLista,
} from '../src/domain/loja/motivosDaSeparacao.js';
import { cabecalhoDaOrigem, origemDoCabecalho } from '../src/domain/logs/origemDaAcao.js';
import { createMotivosDaSeparacaoRoutes } from '../src/http/routes/motivosDaSeparacaoRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-16 e B57-16b, item 11 (proposta aprovada B57-16-11-proposta-motivos.md): motivos da
// separacao por loja (estabelecimentos/{loja}/MotivosDaSeparacao), os 8 padroes fixos no Core com id fixo,
// as rotas do web (listar, criar, editar, apagar, com Logs e X-Origem) e do App Gerenciador (chips por
// tipo; ao concluir a separacao, soma o uso e salva o motivo novo marcado), a ordem por uso e o chip de 24.
const COLECAO = 'estabelecimentos/loja-1/MotivosDaSeparacao';

test('B57-16b item 11: os 8 padroes do item 10, com id fixo e "usar em"', () => {
  assert.deepEqual(MOTIVOS_PADRAO.map((m) => [m.id, m.texto, m.troca, m.remocao]), [
    ['padrao_produto_em_falta', 'Produto em falta', true, true],
    ['padrao_sem_estoque_no_momento', 'Sem estoque no momento', true, true],
    ['padrao_produto_com_avaria', 'Produto com avaria', true, true],
    ['padrao_fora_da_validade', 'Fora da validade', true, true],
    ['padrao_estamos_sem_opcao_equivalente', 'Estamos sem opção equivalente', true, true],
    ['padrao_trocamos_por_um_similar', 'Trocamos por um similar', true, false],
    ['padrao_marca_indisponivel_no_momento', 'Marca indisponível no momento', true, true],
    ['padrao_tamanho_indisponivel', 'Tamanho indisponível', true, true],
  ]);
});

test('B57-16b item 11: chip de 24 caracteres e comparacao sem maiuscula, espaco e ponto final', () => {
  assert.equal(chipDoMotivo('Sem estoque no momento'), 'Sem estoque no momento');
  // B57-16c: o corte passou de 24 para 30 (tests/B57-16c-ChipDe30.test.js); o padrao cabe inteiro.
  assert.equal(chipDoMotivo('Estamos sem opção equivalente'), 'Estamos sem opção equivalente');
  assert.equal(chipDoMotivo('  Fora da validade  '), 'Fora da validade');
  assert.equal(mesmoMotivo('Sem estoque no momento.', 'sem  estoque no momento'), true);
  assert.equal(mesmoMotivo('Sem estoque', 'Sem estoque no momento'), false);
});

test('B57-16b item 11: a lista junta os padroes e os da loja, na ordem de uso, sem o padrao apagado', () => {
  const lista = montarLista([
    { id: 'padrao_fora_da_validade', dados: { usos: 5 } },
    { id: 'padrao_produto_em_falta', dados: { apagado: true } },
    { id: 'padrao_tamanho_indisponivel', dados: { texto: 'Tamanho em falta', remocao: false } },
    { id: 'm1', dados: { texto: 'Cliente pediu para tirar', troca: false, remocao: true, origem: 'app', usos: 2, salvoEm: new Date('2026-11-20') } },
    { id: 'm2', dados: { texto: 'Produto vencido', troca: true, remocao: true, origem: 'web', usos: 0, salvoEm: new Date('2026-11-25') } },
  ]);
  assert.deepEqual(lista.map((m) => m.id), [
    'padrao_fora_da_validade', 'm1',
    'padrao_sem_estoque_no_momento', 'padrao_produto_com_avaria', 'padrao_estamos_sem_opcao_equivalente',
    'padrao_trocamos_por_um_similar', 'padrao_marca_indisponivel_no_momento', 'padrao_tamanho_indisponivel',
    'm2',
  ]);
  const tamanho = lista.find((m) => m.id === 'padrao_tamanho_indisponivel');
  assert.equal(tamanho.texto, 'Tamanho em falta');
  assert.equal(tamanho.origem, 'padrao', 'o padrao editado continua padrao');
  assert.equal(tamanho.remocao, false);
});

test('B57-16b item 11: o App Gerenciador manda a origem do tipo app', () => {
  const valor = cabecalhoDaOrigem({ tipo: 'app', rota: null, caminho: ['App Gerenciador', 'Separação'] });
  assert.equal(origemDoCabecalho(valor).tipo, 'app');
});

function banco() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Zero Grau' },
    'estabelecimentos/loja-1/AdminUsers/f-caixa': { firstName: 'Bia', lastName: 'Caixa', email: 'bia@loja.test', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-caixa': { name: 'Caixa', isAdmin: false, permissions: ['requests.view', 'requests.update_status'] },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Zero Grau', userReference: firestore.doc('Users/doc-dono') });
  return firestore;
}

async function servidor(firestore) {
  const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore });
  const { requirePermission, accountForRequest } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = JSON.parse(request.headers['x-auth']); next(); });
  app.use('/api/loja/motivos-da-separacao', createMotivosDaSeparacaoRoutes({
    motivosDaSeparacao: new MotivosDaSeparacao({ firestore, serverTimestamp: () => new Date('2026-11-26T12:00:00Z') }),
    requirePermission,
    accountForRequest,
  }));
  app.use(errorHandler);
  const ouvindo = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const chamar = async (metodo, caminho, { auth, corpo, origem } = {}) => {
    const resposta = await fetch(`http://127.0.0.1:${ouvindo.address().port}/api/loja/motivos-da-separacao${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'x-auth': JSON.stringify(auth), ...(origem ? { 'X-Origem': origem } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    return { status: resposta.status, corpo: await resposta.json() };
  };
  return { ouvindo, chamar };
}

const DONO = { uid: 'uid-dono' };
const CAIXA = { uid: 'f-caixa', adminOf: 'loja-1', groupId: 'g-caixa' };
const acoes = (firestore) => [...firestore.docs.entries()].filter(([c]) => c.startsWith('estabelecimentos/loja-1/AcoesEquipe/')).map(([, d]) => d);

test('B57-16b item 11: o App Gerenciador le os chips por tipo e, ao concluir, soma o uso e salva o motivo novo', async () => {
  const firestore = banco();
  const { ouvindo, chamar } = await servidor(firestore);
  const doApp = cabecalhoDaOrigem({ tipo: 'app', rota: null, caminho: ['App Gerenciador', 'Separação'] });
  try {
    const remocao = await chamar('GET', '/?tipo=remocao', { auth: CAIXA });
    assert.equal(remocao.status, 200);
    assert.equal(remocao.corpo.data.motivos.length, 7, 'sem "Trocamos por um similar"');
    assert.equal((await chamar('GET', '/?tipo=troca', { auth: CAIXA })).corpo.data.motivos.length, 8);
    // Usou um padrao (com o ponto final do chip): soma o uso, nao duplica.
    const usado = await chamar('POST', '/uso', { auth: CAIXA, corpo: { texto: 'Sem estoque no momento.', salvar: true, tipos: ['troca'] }, origem: doApp });
    assert.equal(usado.status, 200);
    assert.equal(usado.corpo.data.criado, false);
    assert.equal(usado.corpo.data.motivo.usos, 1);
    assert.equal(firestore.docs.get(`${COLECAO}/padrao_sem_estoque_no_momento`).usos, 1);
    // Texto novo sem o check: nada gravado.
    assert.equal((await chamar('POST', '/uso', { auth: CAIXA, corpo: { texto: 'Um caso so' } })).corpo.data.motivo, null);
    // Texto novo com o check: salvo do app, com quem salvou, ligado no tipo, e nos Logs.
    const novo = await chamar('POST', '/uso', { auth: CAIXA, corpo: { texto: 'Cliente desistiu do item', salvar: true, tipos: ['remocao'] }, origem: doApp });
    assert.equal(novo.corpo.data.criado, true);
    assert.deepEqual(
      { origem: novo.corpo.data.motivo.origem, salvoPor: novo.corpo.data.motivo.salvoPor, troca: novo.corpo.data.motivo.troca, remocao: novo.corpo.data.motivo.remocao, usos: novo.corpo.data.motivo.usos },
      { origem: 'app', salvoPor: { id: 'f-caixa', nome: 'Bia Caixa' }, troca: false, remocao: true, usos: 1 },
    );
    const [log] = acoes(firestore);
    assert.equal(log.acao, 'motivo.criar');
    assert.equal(log.origem, 'app');
    assert.equal(log.origemDaAcao.tipo, 'app');
    // Ordem por uso: o novo e o padrao usado na frente.
    const lista = (await chamar('GET', '/', { auth: CAIXA })).corpo.data.motivos.map((m) => m.texto);
    assert.deepEqual(lista.slice(0, 2), ['Sem estoque no momento', 'Cliente desistiu do item']);
    // Sem permissao de editar Ajustes, o caixa nao cria pelo web.
    assert.equal((await chamar('POST', '/', { auth: CAIXA, corpo: { texto: 'X', troca: true, remocao: true } })).status, 403);
  } finally {
    ouvindo.close();
  }
});

test('B57-16b item 11: o web cria, edita e apaga, com os Logs e a origem; validacoes', async () => {
  const firestore = banco();
  const { ouvindo, chamar } = await servidor(firestore);
  const doWeb = cabecalhoDaOrigem({ rota: '/ajustes', caminho: ['Ajustes', 'Motivos da separação'] });
  try {
    const criado = await chamar('POST', '/', { auth: DONO, corpo: { texto: 'Produto vencido', troca: true, remocao: false }, origem: doWeb });
    assert.equal(criado.status, 201);
    const { id } = criado.corpo.data.motivo;
    assert.equal(criado.corpo.data.motivo.origem, 'web');
    assert.deepEqual(criado.corpo.data.motivo.salvoPor, { id: 'uid-dono', nome: 'Zero Grau' });
    assert.equal((await chamar('POST', '/', { auth: DONO, corpo: { texto: 'produto vencido.', troca: true, remocao: false } })).status, 409);
    assert.equal((await chamar('POST', '/', { auth: DONO, corpo: { texto: 'Nada ligado', troca: false, remocao: false } })).status, 400);
    assert.equal((await chamar('POST', '/', { auth: DONO, corpo: { texto: '   ', troca: true, remocao: true } })).status, 400);
    const editado = await chamar('PATCH', `/${id}`, { auth: DONO, corpo: { remocao: true }, origem: doWeb });
    assert.equal(editado.corpo.data.motivo.remocao, true);
    const padrao = await chamar('PATCH', '/padrao_fora_da_validade', { auth: DONO, corpo: { texto: 'Fora do prazo de validade' }, origem: doWeb });
    assert.equal(padrao.corpo.data.motivo.texto, 'Fora do prazo de validade');
    assert.equal(padrao.corpo.data.motivo.origem, 'padrao');
    assert.equal((await chamar('PATCH', '/nao-existe', { auth: DONO, corpo: { troca: true } })).status, 404);
    assert.equal((await chamar('DELETE', '/padrao_produto_em_falta', { auth: DONO, origem: doWeb })).status, 200);
    assert.equal(firestore.docs.get(`${COLECAO}/padrao_produto_em_falta`).apagado, true);
    assert.equal((await chamar('DELETE', `/${id}`, { auth: DONO, origem: doWeb })).status, 200);
    assert.equal(firestore.docs.has(`${COLECAO}/${id}`), false);
    const lista = (await chamar('GET', '/', { auth: DONO })).corpo.data.motivos.map((m) => m.id);
    assert.equal(lista.includes('padrao_produto_em_falta'), false);
    assert.deepEqual(acoes(firestore).map((a) => a.acao).sort(), ['motivo.apagar', 'motivo.apagar', 'motivo.criar', 'motivo.editar', 'motivo.editar']);
    const edicao = acoes(firestore).find((a) => a.acao === 'motivo.editar' && a.alvo.id === 'padrao_fora_da_validade');
    assert.deepEqual(edicao.antes, { texto: 'Fora da validade' });
    assert.deepEqual(edicao.depois, { texto: 'Fora do prazo de validade' });
    assert.equal(edicao.origemDaAcao.caminho.join(' > '), 'Ajustes > Motivos da separação');
    assert.equal(edicao.autor.tipo, 'contaDaLoja');
  } finally {
    ouvindo.close();
  }
});
