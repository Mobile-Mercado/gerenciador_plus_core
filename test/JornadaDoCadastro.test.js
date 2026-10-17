import assert from 'node:assert/strict';
import test from 'node:test';
import { CadastroDeLoja } from '../src/application/cadastro/CadastroDeLoja.js';
import { diaDoFunil, JornadaDoCadastro } from '../src/application/cadastro/JornadaDoCadastro.js';
import { LIMITES, LimiteDeTentativas } from '../src/application/cadastro/LimiteDeTentativas.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const AGORA = Date.parse('2026-10-17T15:00:00Z');
const HOJE = '2026-10-17';
const INSTALACAO = 'inst-0001-abcd';
const IP = '200.10.20.30';

const PASSO1 = {
  nome: 'Ana Paula',
  celular: '(27) 99876-5432',
  email: 'ana@bompreco.com.br',
  erp: { escolhido: 'outro', texto: 'Sistema da casa' },
  aceiteTermos: { aceito: true, em: '2026-10-17T11:59:00-03:00' },
};
const RECEITA = {
  cnpjConferido: true,
  encontrado: true,
  ativa: true,
  situacao: 'ATIVA',
  razaoSocial: 'MERCADO BOM PRECO LTDA',
  nomeFantasia: 'BOM PRECO',
  endereco: { street: 'RUA SETE DE SETEMBRO', number: '410', neighborhood: 'CENTRO', city: 'VITORIA', uf: 'es', zipCode: '29015-000' },
};
const ENDERECO = {
  cep: '29015-000', rua: 'Rua Sete de Setembro', bairro: 'Centro', cidade: 'Vitória', uf: 'ES', lat: -20.3194, lng: -40.3378,
};

function montar(dados = {}) {
  const banco = new FirestoreEmMemoria(dados);
  const limites = new LimiteDeTentativas({ firestore: banco, clock: () => AGORA, paraData: (ms) => new Date(ms) });
  const jornada = new JornadaDoCadastro({ firestore: banco, limites, clock: () => AGORA, paraData: (ms) => new Date(ms) });
  return { banco, jornada };
}

async function recusa(promessa, codigo) {
  await assert.rejects(promessa, (erro) => erro.code === codigo);
}

function eventos(banco) {
  return [...banco.docs.entries()]
    .filter(([caminho]) => caminho.startsWith(`jornadasCadastro/${INSTALACAO}/eventos/`))
    .map(([, dados]) => dados);
}

test('dia do funil no fuso de Sao Paulo', () => {
  assert.equal(diaDoFunil(new Date(AGORA)), HOJE);
  assert.equal(diaDoFunil(new Date('2026-10-18T02:30:00Z')), HOJE);
});

test('abertura: cria a instalacao, grava o evento com as duas horas e conta no funil do dia', async () => {
  const { banco, jornada } = montar();
  await jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'abertura', horaDoAparelho: '2026-10-17T11:58:00-03:00' }, { ip: IP });
  await jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'abertura', horaDoAparelho: AGORA }, { ip: IP });

  const doc = banco.dados(`jornadasCadastro/${INSTALACAO}`);
  assert.equal(doc.situacao, null);
  assert.equal(doc.aberturas, 2);
  assert.equal(doc.cidadeAcesso, null);
  assert.equal(doc.ultimaAberturaDia, HOJE);
  assert.ok(doc.primeiraAbertura instanceof Date);

  const lista = eventos(banco);
  assert.equal(lista.length, 2);
  assert.equal(lista[0].tipo, 'abertura');
  assert.equal(lista[0].cidadeAcesso, null);
  assert.ok(lista[0].em instanceof Date, 'hora do servidor');
  assert.equal(lista[0].horaDoAparelho.toISOString(), '2026-10-17T14:58:00.000Z');
  assert.equal(lista[0].expiraEm.toISOString(), new Date(AGORA + 180 * 24 * 60 * 60 * 1000).toISOString());

  const funil = banco.dados(`funilCadastro/${HOJE}`);
  assert.equal(funil.aberturas, 2);
  assert.equal(funil.instalacoesNovas, 1);
  assert.equal(funil.instalacoesAbertas, 1, 'a mesma instalacao conta uma vez por dia');

  // Nunca o endereco de rede: nem o IP, nem nada que o contenha (o limite guarda so o hash).
  assert.equal(JSON.stringify([...banco.docs.values()]).includes(IP), false);
});

test('comecar, entrar e sair de passo: situacao em andamento e passos com entrada e saida', async () => {
  const { banco, jornada } = montar();
  await jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'comecar' });
  await jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'entrou_passo', passo: 1 });
  await jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'saiu_passo', passo: 1 });
  await jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'entrou_passo', passo: 1 });
  await jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'retomou' });

  const doc = banco.dados(`jornadasCadastro/${INSTALACAO}`);
  assert.equal(doc.situacao, 'em_andamento');
  assert.equal(doc.passoAtual, 1);
  assert.equal(doc.passos['1'].entradas, 2);
  assert.equal(doc.passos['1'].saidas, 1);
  assert.ok(doc.passos['1'].primeiraEntrada instanceof Date);
  assert.ok(doc.passos['1'].ultimaSaida instanceof Date);
  assert.equal(doc.retomadas, 1);

  const funil = banco.dados(`funilCadastro/${HOJE}`);
  assert.equal(funil.comecar, 1);
  assert.equal(funil.cadastrosComecados, 1);
  assert.deepEqual(funil.entrouPasso, { 1: 2 });
  assert.deepEqual(funil.saiuPasso, { 1: 1 });
  assert.equal(funil.retomou, 1);

  await recusa(jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'clicou' }), 'cadastro_evento_invalido');
  await recusa(jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'entrou_passo', passo: 4 }), 'cadastro_passo_invalido');
  await recusa(jornada.registrarEvento({ instalacaoId: 'x', tipo: 'abertura' }), 'cadastro_instalacao_invalido');
  await recusa(jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'abertura', horaDoAparelho: 'ontem' }), 'cadastro_hora_invalido');
});

test('rascunho: dados pessoais so a partir do passo 1 com aceite; nunca senha', async () => {
  const { banco, jornada } = montar();
  await recusa(jornada.gravarRascunho({ instalacaoId: INSTALACAO, passo: 2, dados: { cnpj: '11222333000181', receita: RECEITA } }), 'cadastro_rascunho_sem_aceite');
  await recusa(jornada.gravarRascunho({ instalacaoId: INSTALACAO, passo: 1, dados: { ...PASSO1, aceiteTermos: { aceito: false } } }), 'cadastro_termos_invalido');
  await recusa(jornada.gravarRascunho({ instalacaoId: INSTALACAO, passo: 1, dados: { ...PASSO1, senha: '12345678' } }), 'cadastro_rascunho_invalido');
  assert.equal(banco.dados(`jornadasCadastro/${INSTALACAO}`), undefined, 'recusa nao grava nada');

  await jornada.gravarRascunho({ instalacaoId: INSTALACAO, passo: 1, dados: PASSO1 });
  let doc = banco.dados(`jornadasCadastro/${INSTALACAO}`);
  assert.equal(doc.situacao, 'em_andamento');
  assert.equal(doc.ultimoPassoComDados, 1);
  assert.equal(doc.dados.passo1.nome, 'Ana Paula');
  assert.equal(doc.dados.passo1.celular, '27998765432');
  assert.deepEqual(doc.dados.passo1.erp, { escolhido: 'outro', texto: 'Sistema da casa' });
  assert.equal(doc.dados.passo1.aceiteTermos.aceito, true);
  assert.equal(doc.dados.passo1.aceiteTermos.horaDoAparelho.toISOString(), '2026-10-17T14:59:00.000Z');
  assert.ok(doc.dados.passo1.aceiteTermos.registradoEm instanceof Date);

  await jornada.gravarRascunho({ instalacaoId: INSTALACAO, passo: 2, dados: { cnpj: '11.222.333/0001-81', receita: { ...RECEITA, html: '<b>' } } });
  await jornada.gravarRascunho({ instalacaoId: INSTALACAO, passo: 3, dados: { endereco: ENDERECO } });
  doc = banco.dados(`jornadasCadastro/${INSTALACAO}`);
  assert.equal(doc.ultimoPassoComDados, 3);
  assert.equal(doc.dados.passo2.cnpj, '11222333000181');
  assert.equal(doc.dados.passo2.receita.nomeFantasia, 'BOM PRECO');
  assert.equal('html' in doc.dados.passo2.receita, false);
  assert.equal(doc.cidadeReceita, 'VITORIA');
  assert.equal(doc.ufReceita, 'ES');
  assert.equal(doc.dados.passo3.endereco.numero, null, 'o numero vem depois, na folha do endereco');
  assert.equal(JSON.stringify(doc).includes('12345678'), false);
  assert.deepEqual(banco.dados(`funilCadastro/${HOJE}`).rascunhoPasso, { 1: 1, 2: 1, 3: 1 });

  // Gravar o mesmo passo de novo atualiza os dados e nao conta outra vez no funil.
  await jornada.gravarRascunho({ instalacaoId: INSTALACAO, passo: 1, dados: { ...PASSO1, nome: 'Ana Paula Souza' } });
  assert.equal(banco.dados(`jornadasCadastro/${INSTALACAO}`).dados.passo1.nome, 'Ana Paula Souza');
  assert.equal(banco.dados(`funilCadastro/${HOJE}`).rascunhoPasso['1'], 1);
});

test('pedido completo (POST /loja) conclui a instalacao com o id do pedido; a aprovacao grava o da loja', async () => {
  const { banco, jornada } = montar();
  await jornada.gravarRascunho({ instalacaoId: INSTALACAO, passo: 1, dados: PASSO1 });
  const cadastro = new CadastroDeLoja({
    firestore: banco,
    auth: new AuthEmMemoria(),
    consultaCnpj: { consultar: async () => null },
    jornada,
    serverTimestamp: () => new Date('2026-10-17T15:00:00Z'),
    pontoNoMapa: (latitude, longitude) => ({ latitude, longitude }),
  });
  const criado = await cadastro.criar({
    cnpj: '11.222.333/0001-81',
    nome: 'Bom Preço',
    responsavel: { nome: 'Ana Paula', celular: '27998765432', email: 'ana@bompreco.com.br' },
    erp: { escolhido: 'nao_sei' },
    endereco: { ...ENDERECO, numero: '410' },
    instalacaoId: INSTALACAO,
    senha: 'senha-forte',
  });
  const doc = banco.dados(`jornadasCadastro/${INSTALACAO}`);
  assert.equal(doc.situacao, 'concluido');
  assert.equal(doc.pedidoId, criado.pedidoId);
  assert.ok(criado.pedidoId);
  assert.equal(doc.lojaId, undefined, 'sem loja ate o Aprovar');
  await jornada.aprovada(INSTALACAO, 'loja-nova');
  assert.equal(banco.dados(`jornadasCadastro/${INSTALACAO}`).lojaId, 'loja-nova');
  assert.ok(doc.concluidoEm);
  assert.equal(banco.dados(`funilCadastro/${HOJE}`).concluidos, 1);
  await recusa(jornada.gravarRascunho({ instalacaoId: INSTALACAO, passo: 1, dados: PASSO1 }), 'cadastro_rascunho_concluido');
});

test('limite por IP da jornada: conta propria, separada das 5 tentativas do cadastro', async () => {
  assert.deepEqual(LIMITES.jornada, { maximo: 300, janelaMs: 24 * 60 * 60 * 1000 });
  const { jornada } = montar();
  for (let vez = 0; vez < LIMITES.jornada.maximo; vez += 1) {
    // eslint-disable-next-line no-await-in-loop
    await jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'abertura' }, { ip: IP });
  }
  await recusa(jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'abertura' }, { ip: IP }), 'cadastro_tentativas_excedidas');
  await jornada.registrarEvento({ instalacaoId: INSTALACAO, tipo: 'abertura' }, { ip: '200.10.20.31' });
});

test('rotas: POST /evento e /rascunho sem login, com App Check quando ligado', async () => {
  const { default: express } = await import('express');
  const { createCadastroRoutes } = await import('../src/http/routes/cadastroRoutes.js');
  const { createAppCheckMiddleware } = await import('../src/http/middlewares/appCheck.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { banco, jornada } = montar();
  const subir = (exigir) => {
    const app = express();
    app.use(express.json());
    app.use('/api/cadastro', createCadastroRoutes({
      cadastroDeLoja: {},
      jornadaDoCadastro: jornada,
      appCheck: createAppCheckMiddleware({ exigir, verificar: async (token) => { if (token !== 'ok') throw new Error('x'); } }),
      exigirLogin: (_request, _response, next) => next(),
      registrar: () => {},
    }));
    app.use(errorHandler);
    return new Promise((resolve) => { const servidor = app.listen(0, () => resolve(servidor)); });
  };
  const enviar = (base, caminho, corpo, cabecalhos = {}) => fetch(`${base}${caminho}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...cabecalhos }, body: JSON.stringify(corpo),
  });

  const servidor = await subir(false);
  const base = `http://127.0.0.1:${servidor.address().port}/api/cadastro`;
  try {
    const evento = await enviar(base, '/evento', { instalacaoId: INSTALACAO, tipo: 'entrou_passo', passo: 2, horaDoAparelho: AGORA });
    assert.equal(evento.status, 201);
    assert.deepEqual((await evento.json()).data, { instalacaoId: INSTALACAO, tipo: 'entrou_passo', passo: 2 });

    const rascunho = await enviar(base, '/rascunho', { instalacaoId: INSTALACAO, passo: 1, dados: PASSO1 });
    assert.equal(rascunho.status, 200);
    assert.deepEqual((await rascunho.json()).data, { instalacaoId: INSTALACAO, passo: 1 });
    assert.equal(banco.dados(`jornadasCadastro/${INSTALACAO}`).dados.passo1.email, 'ana@bompreco.com.br');

    const semPasso = await enviar(base, '/rascunho', { instalacaoId: INSTALACAO, dados: PASSO1 });
    assert.equal(semPasso.status, 400);
    const comSenha = await enviar(base, '/rascunho', { instalacaoId: INSTALACAO, passo: 1, dados: { ...PASSO1, senha: '12345678' } });
    assert.equal(comSenha.status, 400);
    assert.equal((await comSenha.json()).error.code, 'cadastro_rascunho_invalido');
  } finally {
    servidor.close();
  }

  const comAppCheck = await subir(true);
  const baseApp = `http://127.0.0.1:${comAppCheck.address().port}/api/cadastro`;
  try {
    const semToken = await enviar(baseApp, '/evento', { instalacaoId: INSTALACAO, tipo: 'abertura' });
    assert.equal(semToken.status, 401);
    const comToken = await enviar(baseApp, '/evento', { instalacaoId: INSTALACAO, tipo: 'abertura' }, { 'X-Firebase-AppCheck': 'ok' });
    assert.equal(comToken.status, 201);
  } finally {
    comAppCheck.close();
  }
});
