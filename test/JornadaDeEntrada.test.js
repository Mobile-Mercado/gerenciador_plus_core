import assert from 'node:assert/strict';
import test from 'node:test';
import { JornadaDeEntrada } from '../src/application/admin/JornadaDeEntrada.js';
import { PedidosDeLoja } from '../src/application/admin/PedidosDeLoja.js';
import { ClienteDaPlataforma } from '../src/application/cadastro/ClienteDaPlataforma.js';
import { JornadaDoCadastro } from '../src/application/cadastro/JornadaDoCadastro.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const T0 = Date.parse('2026-10-17T12:00:00Z');
const SEG = 1000;
const PASSO1 = (nome) => ({
  nome, celular: '27998765432', email: `${nome.split(' ')[0].toLowerCase()}@bp.com.br`, erp: { escolhido: 'nao_sei' }, aceiteTermos: { aceito: true },
});
const receita = (city, uf) => ({ encontrado: true, ativa: true, razaoSocial: `MERCADO ${city}`, endereco: { city, uf } });
const ENDERECO = { rua: 'Rua A', cidade: 'Vitória', uf: 'ES', lat: -20.3, lng: -40.3 };

// Jornadas gravadas pelo proprio JornadaDoCadastro, com relogio controlado para os tempos.
async function cenario() {
  const banco = new FirestoreEmMemoria();
  let agora = T0;
  const jornada = new JornadaDoCadastro({
    firestore: banco, clock: () => agora, serverTimestamp: () => new Date(agora), paraData: (ms) => new Date(ms),
  });
  const em = (deslocamento) => { agora = T0 + deslocamento * SEG; };
  const evento = (instalacaoId, tipo, passo, opcoes) => jornada.registrarEvento({ instalacaoId, tipo, passo }, opcoes);
  const rascunho = (instalacaoId, passo, dados) => jornada.gravarRascunho({ instalacaoId, passo, dados });

  // Fora do periodo: nasceu 40 dias antes.
  em(-40 * 24 * 3600); await evento('inst-antiga-01', 'abertura');

  // A: do comeco ao fim, aprovada.
  em(0); await evento('inst-completa', 'abertura');
  em(60); await evento('inst-completa', 'comecar'); await evento('inst-completa', 'entrou_passo', 1);
  em(120); await rascunho('inst-completa', 1, PASSO1('Ana Paula'));
  em(180); await evento('inst-completa', 'entrou_passo', 2);
  em(200); await rascunho('inst-completa', 2, { cnpj: '11222333000181', receita: receita('VITORIA', 'ES') });
  em(300); await evento('inst-completa', 'entrou_passo', 3);
  em(400);
  // Pedido de loja (pedidosDeLoja), ja aprovado.
  banco.docs.set('pedidosDeLoja/pedido-a', {
    name: 'A', status: 'aprovada', lojaId: 'loja-a', enviadoEm: new Date(T0 + 1000 * SEG), aprovadoEm: new Date(T0 + 5000 * SEG),
    enderecoReceita: { city: 'VITORIA', uf: 'ES' },
  });
  await jornada.concluir('inst-completa', 'pedido-a');

  // B: parou no CNPJ (Serra - ES).
  em(10); await evento('inst-parou-cnpj', 'abertura');
  em(40); await evento('inst-parou-cnpj', 'entrou_passo', 1);
  em(50); await rascunho('inst-parou-cnpj', 1, PASSO1('Bruno Lima'));
  em(70); await evento('inst-parou-cnpj', 'entrou_passo', 2);
  em(90); await rascunho('inst-parou-cnpj', 2, { cnpj: '11222333000181', receita: receita('SERRA', 'ES') });

  // C: so abriu.
  em(20); await evento('inst-so-abriu', 'abertura');

  // D: lojista que ja e cliente, logado na abertura: sai do corte.
  em(30); await evento('inst-lojista-cli', 'abertura', undefined, { cliente: { lojaId: 'loja-antiga' } });

  // F: parou no endereco (Sao Paulo - SP).
  em(15); await evento('inst-parou-ender', 'abertura');
  em(25); await evento('inst-parou-ender', 'entrou_passo', 1);
  em(30); await rascunho('inst-parou-ender', 1, PASSO1('Carla Dias'));
  em(45); await evento('inst-parou-ender', 'entrou_passo', 2);
  em(55); await rascunho('inst-parou-ender', 2, { cnpj: '11222333000181', receita: receita('SAO PAULO', 'SP') });
  em(85); await evento('inst-parou-ender', 'entrou_passo', 3);
  em(95); await rascunho('inst-parou-ender', 3, { endereco: ENDERECO });

  em(6000);
  const pedidos = new PedidosDeLoja({ firestore: banco, auth: new AuthEmMemoria(), jornada });
  await pedidos.marcarIncompleto('inst-parou-cnpj', 'descartado', { uid: 'uid-admin' });
  await pedidos.marcarIncompleto('inst-parou-ender', 'em_conversa', { uid: 'uid-admin' });
  return { banco, pedidos, leitura: new JornadaDeEntrada({ firestore: banco, clock: () => T0 + 6000 * SEG }) };
}

test('resumo: acessos com e sem o corte dos lojistas clientes, contas, clientes e tempo do cadastro', async () => {
  const { leitura } = await cenario();
  const { resumo, periodo } = await leitura.ler({ periodo: 30 });
  assert.equal(periodo.dias, 30);
  assert.deepEqual(resumo, {
    acessos: 4,
    acessosSemCorte: 5,
    instalacoesDeClientesCortadas: 1,
    contas: 1,
    clientes: 1,
    tempoMedioCadastroSeg: 340,
  });
});

test('funil por tela: pessoas, perda em relacao a anterior e tempo medio na tela', async () => {
  const { leitura } = await cenario();
  const { funil } = await leitura.ler({ periodo: 30 });
  assert.deepEqual(funil.map(({ tela, pessoas, perda }) => [tela, pessoas, perda]), [
    ['Abertura', 4, null],
    ['Dados do dono', 3, 1],
    ['CNPJ e senha', 3, 0],
    ['Endereço e fachada', 2, 1],
    ['Pedido enviado', 1, 1],
    ['E-mail confirmado', 1, 0],
    ['Aprovado', 1, 0],
  ]);
  const porChave = Object.fromEntries(funil.map((linha) => [linha.chave, linha]));
  assert.equal(porChave.dados.perdaPct, 25);
  // Abertura ate a tela 1: 60 s (A), 30 s (B), 10 s (F).
  assert.equal(porChave.abertura.tempoMedioSeg, 33);
  // Tela 1 ate a 2: 120 s (A), 30 s (B), 20 s (F).
  assert.equal(porChave.dados.tempoMedioSeg, 57);
  assert.equal(porChave.endereco.tempoMedioSeg, 100, 'do passo 3 ao pedido criado');
  assert.equal(porChave.pedido.tempoMedioSeg, 600, 'do pedido ao e-mail confirmado');
  assert.equal(porChave.email.tempoMedioSeg, 4000, 'do e-mail a aprovacao');
  assert.equal(porChave.aprovado.tempoMedioSeg, null);
});

test('por cidade: acessos pela cidade do acesso (hoje nao identificada), leads e aprovados pela Receita', async () => {
  const { leitura } = await cenario();
  const { porLocal } = await leitura.ler({ periodo: 30 });
  assert.deepEqual(porLocal.acessos, [{ cidade: 'Não identificada', uf: null, quantidade: 4 }]);
  assert.deepEqual(porLocal.leads, [
    { cidade: 'SAO PAULO', uf: 'SP', quantidade: 1 },
    { cidade: 'SERRA', uf: 'ES', quantidade: 1 },
    { cidade: 'VITORIA', uf: 'ES', quantidade: 1 },
  ]);
  assert.deepEqual(porLocal.aprovados, [{ cidade: 'VITORIA', uf: 'ES', quantidade: 1 }]);
});

test('filtro de estado e periodo: so a turma do estado e da janela', async () => {
  const { leitura } = await cenario();
  const es = await leitura.ler({ periodo: 30, uf: 'es' });
  assert.equal(es.estado, 'ES');
  assert.equal(es.resumo.acessos, 2, 'sem cidade do acesso, so quem tem a UF da Receita entra no filtro');
  assert.deepEqual(es.leadsNaoConcluidos.map((lead) => lead.instalacaoId), ['inst-parou-cnpj']);
  const noventa = await leitura.ler({ periodo: 90 });
  assert.equal(noventa.resumo.acessos, 5, 'a instalacao de 40 dias atras entra em 90 dias');
  await assert.rejects(leitura.ler({ periodo: 15 }), (erro) => erro.code === 'jornada_periodo_invalido');
  await assert.rejects(leitura.ler({ periodo: 30, uf: 'Espirito' }), (erro) => erro.code === 'jornada_estado_invalido');
});

test('leads que nao concluiram com a situacao; o Kanban volta de Descartado para Em andamento', async () => {
  const { leitura, pedidos } = await cenario();
  const { leadsNaoConcluidos } = await leitura.ler({ periodo: 30 });
  assert.deepEqual(
    leadsNaoConcluidos.map(({ instalacaoId, situacao, etapa, cidadeReceita }) => [instalacaoId, situacao, etapa, cidadeReceita]).sort(),
    [['inst-parou-cnpj', 'descartado', 2, 'SERRA'], ['inst-parou-ender', 'em_conversa', 3, 'SAO PAULO']],
  );
  assert.equal((await pedidos.marcarIncompleto('inst-parou-cnpj', 'em_andamento', {})).situacao, 'em_andamento');
  assert.equal((await pedidos.marcarIncompleto('inst-parou-cnpj', 'descartado', {})).situacao, 'descartado');
});

test('abrir a tela nao grava nada', async () => {
  const { banco, leitura } = await cenario();
  const antes = banco.escritas.length;
  await leitura.ler({ periodo: 7 });
  assert.equal(banco.escritas.length, antes);
});

test('lojista cliente: token na abertura, conta com loja aprovada ou antiga; em cadastro ou sem token nao', async () => {
  const contas = {
    'tok-aprovada': { uid: 'u1', loja: { hasEstablishment: true, establishmentId: 'l1', establishmentDocument: { status: 'aprovada' } } },
    'tok-antiga': { uid: 'u2', loja: { hasEstablishment: true, establishmentId: 'l2', establishmentDocument: { status: null } } },
    'tok-em-analise': { uid: 'u3', loja: { hasEstablishment: true, establishmentId: 'l3', establishmentDocument: { status: 'em_analise' } } },
    'tok-sem-loja': { uid: 'u4', loja: { hasEstablishment: false } },
  };
  const porUid = Object.fromEntries(Object.values(contas).map(({ uid, loja }) => [uid, loja]));
  const cliente = new ClienteDaPlataforma({
    verificarToken: async (token) => { if (!contas[token]) throw new Error('token invalido'); return { uid: contas[token].uid }; },
    accessRepository: { findAccountByClaims: async ({ uid }) => porUid[uid] },
  });
  const com = (token) => cliente.daRequisicao({ headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.deepEqual(await com('tok-aprovada'), { lojaId: 'l1' });
  assert.deepEqual(await com('tok-antiga'), { lojaId: 'l2' });
  assert.equal(await com('tok-em-analise'), null);
  assert.equal(await com('tok-sem-loja'), null);
  assert.equal(await com('tok-falso'), null);
  assert.equal(await com(null), null);
});

test('rota GET /api/admin/jornada-de-entrada: periodo 7, 30 ou 90 e estado', async () => {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { leitura } = await cenario();
  const app = express();
  app.use('/api/admin', createAdminRoutes({ jornadaDeEntrada: leitura }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/jornada-de-entrada`;
  try {
    const padrao = await (await fetch(base)).json();
    assert.equal(padrao.data.periodo.dias, 30);
    assert.equal((await (await fetch(`${base}?periodo=7&uf=SP`)).json()).data.estado, 'SP');
    assert.equal((await fetch(`${base}?periodo=15`)).status, 400);
  } finally {
    servidor.close();
  }
});

test('POST /api/cadastro/evento com token: a abertura marca lojistaCliente; sem token, nao', async () => {
  const { default: express } = await import('express');
  const { createCadastroRoutes } = await import('../src/http/routes/cadastroRoutes.js');
  const banco = new FirestoreEmMemoria();
  const jornada = new JornadaDoCadastro({ firestore: banco, clock: () => T0, paraData: (ms) => new Date(ms) });
  const app = express();
  app.use(express.json());
  app.use('/api/cadastro', createCadastroRoutes({
    cadastroDeLoja: {},
    jornadaDoCadastro: jornada,
    clienteDaPlataforma: { daRequisicao: async (request) => (request.headers.authorization === 'Bearer ok' ? { lojaId: 'loja-1' } : null) },
    appCheck: (_request, _response, next) => next(),
    exigirLogin: (_request, _response, next) => next(),
    registrar: () => {},
  }));
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const enviar = (instalacaoId, tipo, token) => fetch(`http://127.0.0.1:${servidor.address().port}/api/cadastro/evento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ instalacaoId, tipo }),
  });
  try {
    assert.equal((await enviar('inst-logada-01', 'abertura', 'ok')).status, 201);
    assert.equal((await enviar('inst-anonima-01', 'abertura')).status, 201);
    assert.equal((await enviar('inst-comecou-01', 'comecar', 'ok')).status, 201);
    assert.equal(banco.dados('jornadasCadastro/inst-logada-01').lojistaCliente, true);
    assert.equal(banco.dados('jornadasCadastro/inst-logada-01').lojistaLojaId, 'loja-1');
    assert.equal(banco.dados('jornadasCadastro/inst-anonima-01').lojistaCliente, undefined);
    assert.equal(banco.dados('jornadasCadastro/inst-comecou-01').lojistaCliente, undefined, 'so a abertura marca');
  } finally {
    servidor.close();
  }
});
