import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { AparenciaDaLoja } from '../src/application/loja/AparenciaDaLoja.js';
import { BLOCOS_DA_JORNADA, blocoDaLoja, eLottie, padroesDoBloco } from '../src/domain/loja/primeiroAcesso.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola B56-24, item A2: dados da jornada "Primeiro acesso" na loja, envio de imagens e animacao,
// animacao padrao de todas as lojas (aparenciaPadrao/abertura) e rotas do Admin. Padroes e faixas
// do mockup aprovado (aparencias-login.html) e do contrato-primeiro-acesso.md.
const LOJA = 'estabelecimentos/loja-1';
const AGORA = new Date('2026-11-15T12:00:00Z');
const LOTTIE = { v: '5.7.4', fr: 30, ip: 0, op: 60, w: 200, h: 200, layers: [] };
const base64 = (buffer) => Buffer.from(buffer).toString('base64');
const json = (objeto) => Buffer.from(JSON.stringify(objeto));
const svg = (largura, altura, extra = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}" viewBox="0 0 ${largura} ${altura}"><rect width="10" height="10"/>${extra}</svg>`);

function montar(lojas = {}, extras = {}) {
  const banco = new FirestoreEmMemoria({
    [LOJA]: { name: 'Loja 1', splashImageUrl: 'https://splash/antiga.webp' },
    'estabelecimentos/loja-2': { name: 'Loja 2' },
    'estabelecimentos/loja-3': { name: 'Loja 3', abertura: { animacaoUrl: 'https://propria/3.json', tipo: 'animacao' } },
    'estabelecimentos/loja-4': { name: 'Loja 4', abertura: { animacaoUrl: 'https://propria/4.json' } },
    ...lojas,
    ...extras,
  });
  const armazenamento = {
    name: 'b',
    salvos: [],
    file(caminho) {
      const dono = this;
      return { save: async (conteudo, opcoes) => { dono.salvos.push({ caminho, bytes: conteudo.length, contentType: opcoes.contentType }); } };
    },
  };
  let relogio = 1000;
  const aparencia = new AparenciaDaLoja({ firestore: banco, bucket: armazenamento, serverTimestamp: () => AGORA, agora: () => relogio++ });
  return { banco, armazenamento, aparencia };
}

test('padroes: loja sem nada gravado le os padroes do mockup aprovado', async () => {
  const { aparencia } = montar();
  const lida = await aparencia.ler('loja-1');
  assert.deepEqual(lida.primeiraTela, {
    logoUrl: null, logoTamanho: 100, logoY: 50, logoAlinhamento: 'centro', cor: '#FFFFFF', mesmaCorDaAbertura: false,
    imagemUrl: null, escurecer: 0, rodapeLigado: false, rodape: '',
  });
  assert.deepEqual(lida.abertura, {
    tipo: 'imagem', animacaoUrl: null, cor: null, rodapeLigado: true, rodape: 'Powered by: Móbile', tempoMinimo: 1.5,
    imagemUrl: 'https://splash/antiga.webp', animacaoPropria: false,
  });
  assert.deepEqual(lida.boasVindas, {
    cor: null, imagemFundoUrl: null, escurecer: 20, logoLigado: false, logoTamanho: 100, imagemLigada: true, imagemUrl: null,
    imagemTamanho: 100, titulo: 'Suas compras com mais\nrapidez e facilidade', texto: '', corTexto: '#FFFFFF',
    botaoPrincipal: 'Criar meu acesso e entrar', botaoSecundario: 'Já tenho acesso', semCadastroLigado: true,
    semCadastro: 'Entrar sem fazer cadastro', corBotao: '#FFFFFF', corTextoBotao: '#2E4BD6',
  });
  assert.deepEqual(lida.login, {
    logoUrl: null, logoTamanho: 60, logoY: 77, logoAlinhamento: 'centro', logoFundo: 'sem', logoCor: 'original', logoCorHex: '#FFFFFF',
    alturaArea: 196, cantoFolha: 28, cor: null, imagemFundoUrl: null, imagemAjuste: 'preencher', escurecer: 20,
    titulo: 'Digite seu número de celular', botao: 'Continuar', frase: 'ou entre com sua conta Google ou Apple',
    googleLigado: true, appleLigado: true,
  });
  assert.deepEqual(lida.codigoSms, {
    cor: '#2E4BD6', corFundo: '#FFFFFF', titulo: 'Informe o código que você\nrecebeu por SMS:', tempo: 10,
    fraseReenvio: 'Não recebeu o código?', botaoReenvio: 'Reenviar código', outraFormaLigada: true,
    fraseOutraForma: 'Não consegue receber SMS?', botaoOutraForma: 'Acessar de outra forma',
  });
  assert.deepEqual(lida.folhaNome, { titulo: 'Como prefere ser chamado?', campo: 'Qual seu nome', botao: 'Salvar', ilustracaoUrl: null });
  assert.deepEqual(lida.folhaEndereco, { titulo: 'Onde entregar as suas compras?', texto: '', botao: 'Adicionar endereço', pularLigado: true, pular: 'Agora não' });
  assert.deepEqual(lida.aberturaPadrao, { nome: null, animacaoUrl: null });
});

test('leitura: valor gravado fora da faixa ou do tipo vale o padrao; cor sai em maiusculas', () => {
  const lido = blocoDaLoja('codigoSms', { codigoSms: { tempo: 7, cor: '#abcdef', titulo: 42, outraFormaLigada: 'nao' } });
  assert.equal(lido.tempo, 10, '7 esta fora da faixa 10 a 120');
  assert.equal(lido.cor, '#ABCDEF');
  assert.equal(lido.titulo, 'Informe o código que você\nrecebeu por SMS:');
  assert.equal(lido.outraFormaLigada, true);
  assert.equal(blocoDaLoja('abertura', { abertura: { tempoMinimo: 1.25 } }).tempoMinimo, 1.5, 'passo de 0,5');
  assert.equal(blocoDaLoja('abertura', { abertura: { tempoMinimo: 0 } }).tempoMinimo, 0);
  assert.equal(blocoDaLoja('boasVindas', { boasVindas: { texto: '' } }).texto, '', 'texto vazio fica vazio (some no app)');
  // Toda faixa numerica tem o padrao dentro dela.
  for (const [nome, campos] of Object.entries(BLOCOS_DA_JORNADA)) {
    for (const [chave, campo] of Object.entries(campos)) {
      if (campo.tipo === 'numero') assert.equal(blocoDaLoja(nome, { [nome]: { [chave]: campo.padrao } })[chave], campo.padrao, `${nome}.${chave}`);
    }
  }
});

test('gravar: cada chave da jornada sozinha, com o valor de antes; null volta ao padrao; splashImageUrl nao muda', async () => {
  const { aparencia, banco } = montar();
  const resultado = await aparencia.salvar('loja-1', {
    boasVindas: { titulo: 'Oi', semCadastroLigado: false },
    login: { googleLigado: false, alturaArea: 220 },
    codigoSms: { tempo: 30 },
    folhaNome: { titulo: 'Seu nome?' },
    folhaEndereco: { pularLigado: false },
    abertura: { tempoMinimo: 3, rodape: 'Feito pela Móbile' },
    primeiraTela: { mesmaCorDaAbertura: true, logoAlinhamento: 'esquerda' },
  });
  assert.deepEqual(resultado.campos, [
    'boasVindas.titulo', 'boasVindas.semCadastroLigado', 'login.googleLigado', 'login.alturaArea', 'codigoSms.tempo',
    'folhaNome.titulo', 'folhaEndereco.pularLigado', 'abertura.tempoMinimo', 'abertura.rodape',
    'primeiraTela.mesmaCorDaAbertura', 'primeiraTela.logoAlinhamento',
  ]);
  assert.equal(resultado.antes['boasVindas.titulo'], null);
  assert.equal(resultado.aparencia.login.alturaArea, 220);
  assert.equal(resultado.aparencia.login.appleLigado, true, 'o que nao foi gravado continua no padrao');
  assert.equal(banco.dados(LOJA).splashImageUrl, 'https://splash/antiga.webp');
  const depois = await aparencia.salvar('loja-1', { codigoSms: { tempo: null } });
  assert.equal(depois.antes['codigoSms.tempo'], 30);
  assert.equal(depois.aparencia.codigoSms.tempo, 10);
  assert.equal(banco.dados(LOJA).codigoSms.tempo, undefined);
});

test('arquivos da jornada: PNG, WEBP ou SVG, com o limite de cada quadro; JPG recusado; grava a URL no campo', async () => {
  const { aparencia, banco } = montar();
  const casos = [
    ['primeira-tela-imagem', 'primeiraTela', 'imagemUrl'],
    ['boas-vindas-fundo', 'boasVindas', 'imagemFundoUrl'],
    ['boas-vindas-imagem', 'boasVindas', 'imagemUrl'],
    ['login-logo', 'login', 'logoUrl'],
    ['login-fundo', 'login', 'imagemFundoUrl'],
    ['folha-nome-ilustracao', 'folhaNome', 'ilustracaoUrl'],
  ];
  for (const [alvo, bloco, campo] of casos) {
    const resultado = await aparencia.enviarArquivo('loja-1', alvo, { conteudoBase64: base64(svg(100, 100)), tipoArquivo: 'image/svg+xml' });
    assert.deepEqual(resultado.campos, [`${bloco}.${campo}`]);
    assert.match(banco.dados(LOJA)[bloco][campo], new RegExp(`aparencia%2F${alvo}_\\d+\\.svg`));
    assert.equal(resultado.aparencia[bloco][campo], banco.dados(LOJA)[bloco][campo]);
  }
  // Imagem central da Boas-vindas ate 150 KB (a da Zero Grau tem 137 KB); fundo do Login ate 80 KB.
  const grande = (kb) => Buffer.concat([svg(100, 100), Buffer.alloc(kb * 1024, 32)]);
  await aparencia.enviarArquivo('loja-1', 'boas-vindas-imagem', { conteudoBase64: base64(grande(140)), tipoArquivo: 'image/svg+xml' });
  await assert.rejects(
    aparencia.enviarArquivo('loja-1', 'login-fundo', { conteudoBase64: base64(grande(81)), tipoArquivo: 'image/svg+xml' }),
    (erro) => erro.code === 'aparencia_imagem_tamanho' && erro.message === 'A imagem tem 82 KB. O limite é 80 KB: reduza o arquivo e envie de novo.',
  );
  const jpg = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  await assert.rejects(
    aparencia.enviarArquivo('loja-1', 'login-logo', { conteudoBase64: base64(jpg), tipoArquivo: 'image/jpeg' }),
    (erro) => erro.code === 'aparencia_imagem_tipo' && erro.message === 'Use uma imagem em SVG, PNG ou WEBP.',
  );
  // Os quadros de antes continuam aceitando JPG ate 40 KB.
  await aparencia.enviarArquivo('loja-1', 'abertura-imagem', { conteudoBase64: base64(jpg), tipoArquivo: 'image/jpeg' });
});

test('animacao: so JSON de Lottie (v, fr, ip, op, w, h e layers); outro JSON recusado com mensagem clara', async () => {
  assert.equal(eLottie(LOTTIE), true);
  assert.equal(eLottie({ ...LOTTIE, layers: undefined }), false);
  assert.equal(eLottie({ ...LOTTIE, v: 5 }), false);
  assert.equal(eLottie({ nome: 'qualquer' }), false);
  assert.equal(eLottie([]), false);
  const { aparencia, banco } = montar();
  await assert.rejects(
    aparencia.enviarArquivo('loja-1', 'abertura-animacao', { conteudoBase64: base64(json({ nome: 'x' })), tipoArquivo: 'application/json' }),
    (erro) => erro.code === 'aparencia_animacao_nao_lottie'
      && erro.message === 'Este .json não é uma animação Lottie. Exporte a animação em Lottie (.json) e envie de novo.',
  );
  assert.equal(banco.dados(LOJA).abertura, undefined, 'nada gravado');
  await aparencia.enviarArquivo('loja-1', 'abertura-animacao', { conteudoBase64: base64(json(LOTTIE)), tipoArquivo: 'application/json' });
  assert.equal((await aparencia.ler('loja-1')).abertura.animacaoPropria, true);
});

test('animacao padrao: N lojas sem a propria; sem a caixa, as M com a propria ficam; com a caixa, perdem a propria', async () => {
  const { aparencia, banco, armazenamento } = montar();
  assert.deepEqual(await aparencia.padraoDaAbertura(), { nome: null, animacaoUrl: null, lojas: 2, comAnimacaoPropria: 2 });
  const primeira = await aparencia.trocarAnimacaoPadrao({ conteudoBase64: base64(json(LOTTIE)), tipoArquivo: 'application/json', nome: 'carregando-mobile.json' }, { uid: 'admin-1' });
  assert.equal(primeira.lojasAlteradas, 2);
  assert.equal(primeira.lojasComAnimacaoPropria, 2);
  assert.deepEqual(primeira.lojasLimpas, []);
  const padrao = banco.dados('aparenciaPadrao/abertura');
  assert.equal(padrao.nome, 'carregando-mobile.json');
  assert.match(padrao.animacaoUrl, /appMobile%2FaparenciaPadrao%2Fabertura%2Fanimacao_\d+\.json/);
  assert.equal(padrao.atualizadoPor, 'admin-1');
  assert.equal(armazenamento.salvos.at(-1).contentType, 'application/json');
  assert.equal(banco.dados('estabelecimentos/loja-3').abertura.animacaoUrl, 'https://propria/3.json', 'sem a caixa, a propria fica');
  assert.deepEqual((await aparencia.ler('loja-1')).aberturaPadrao, { nome: 'carregando-mobile.json', animacaoUrl: padrao.animacaoUrl });

  const segunda = await aparencia.trocarAnimacaoPadrao({ conteudoBase64: base64(json(LOTTIE)), tipoArquivo: 'application/json', nome: 'natal.json' }, {}, { incluirAnimacaoPropria: true });
  assert.equal(segunda.lojasAlteradas, 4, 'N + M');
  assert.deepEqual(segunda.lojasLimpas.sort(), ['loja-3', 'loja-4']);
  assert.equal(segunda.antes.nome, 'carregando-mobile.json');
  assert.equal(banco.dados('estabelecimentos/loja-3').abertura.animacaoUrl, undefined);
  assert.equal(banco.dados('estabelecimentos/loja-3').abertura.tipo, 'animacao', 'so a animacao propria sai');
  assert.deepEqual(await aparencia.padraoDaAbertura(), { nome: 'natal.json', animacaoUrl: banco.dados('aparenciaPadrao/abertura').animacaoUrl, lojas: 4, comAnimacaoPropria: 0 });

  await assert.rejects(
    aparencia.trocarAnimacaoPadrao({ conteudoBase64: base64(json({ x: 1 })), tipoArquivo: 'application/json', nome: 'ruim.json' }),
    (erro) => erro.code === 'aparencia_animacao_nao_lottie',
  );
  assert.equal(banco.dados('aparenciaPadrao/abertura').nome, 'natal.json', 'a recusa nao troca a padrao');
});

// ----- Rotas -----
async function comRotas(usar) {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { createAparenciaDaLojaRoutes } = await import('../src/http/routes/aparenciaDaLojaRoutes.js');
  const { createAdminAuditMiddleware } = await import('../src/http/middlewares/adminAudit.js');
  const { createPermissionGuard } = await import('../src/http/middlewares/requirePermission.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const contexto = montar();
  const { requirePermission, accountForRequest } = createPermissionGuard({
    accessRepository: { findAccountByClaims: async () => ({ hasEstablishment: true, establishmentDocument: {}, establishmentId: 'loja-1', permissions: { isAdmin: true, groupId: null, keys: [] } }) },
  });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((request, _response, next) => { request.auth = { uid: request.headers['x-uid'] || 'admin-1', email: 'admin@x' }; next(); });
  app.use('/api/admin', createAdminAuditMiddleware({ firestore: contexto.banco, serverTimestamp: () => AGORA }), createAdminRoutes({ aparenciaDaLoja: contexto.aparencia }));
  app.use('/api/loja/aparencia', createAparenciaDaLojaRoutes({ aparenciaDaLoja: contexto.aparencia, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const chamar = (metodo, caminho, corpo, uid) => fetch(`${base}${caminho}`, {
    method: metodo, headers: { 'Content-Type': 'application/json', 'x-uid': uid || '' }, body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  try {
    await usar({ chamar, ...contexto });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

const esperarAuditoria = () => new Promise((resolve) => { setTimeout(resolve, 20); });

test('rota do Admin: PATCH dos blocos da jornada com as faixas do contrato; fora da faixa, campo desconhecido ou URL recusados', async () => {
  await comRotas(async ({ chamar, banco }) => {
    const caminho = '/api/admin/estabelecimentos/loja-1/aparencias';
    const recusas = [
      { abertura: { tempoMinimo: 7 } },
      { abertura: { tempoMinimo: 1.25 } },
      { codigoSms: { tempo: 15.5 } },
      { login: { logoAlinhamento: 'meio' } },
      { login: { logoCor: 'azul' } },
      { boasVindas: { titulo: 'x'.repeat(201) } },
      { boasVindas: { corBotao: 'branco' } },
      { boasVindas: { imagemUrl: 'https://x/i.png' } },
      { folhaNome: { ilustracao: null } },
      { folhaEndereco: { pularLigado: 'sim' } },
      { primeiraTela: { escurecer: 80 } },
      { abertura: { imagemUrl: null } },
      { boasVindasExtra: { titulo: 'x' } },
    ];
    for (const corpo of recusas) assert.equal((await chamar('PATCH', caminho, corpo)).status, 400, JSON.stringify(corpo));
    const ok = await chamar('PATCH', caminho, {
      boasVindas: { texto: '', corBotao: '#ffffff', imagemUrl: null },
      codigoSms: { tempo: 120 },
      abertura: { tempoMinimo: 0 },
      login: { logoCor: 'cor', logoCorHex: '#112233' },
    });
    assert.equal(ok.status, 200);
    const dados = (await ok.json()).data;
    assert.equal(dados.boasVindas.corBotao, '#FFFFFF');
    assert.equal(dados.codigoSms.tempo, 120);
    assert.equal(dados.abertura.tempoMinimo, 0);
    assert.equal(dados.login.logoCorHex, '#112233');
    assert.equal(banco.dados(LOJA).boasVindas.texto, '');
    const lottieRuim = await chamar('POST', `${caminho}/arquivos/abertura-animacao`, { conteudoBase64: base64(json({ a: 1 })), tipoArquivo: 'application/json' });
    assert.equal(lottieRuim.status, 400);
    assert.equal((await lottieRuim.json()).error.code, 'aparencia_animacao_nao_lottie');
    assert.equal((await chamar('POST', `${caminho}/arquivos/login-fundo`, { conteudoBase64: base64(svg(10, 10)), tipoArquivo: 'image/svg+xml' })).status, 200);
    await esperarAuditoria();
    const naLoja = [...banco.docs.entries()].filter(([c]) => c.startsWith(`${LOJA}/AdminAuditLogs/`)).map(([, d]) => d.details);
    assert.deepEqual(naLoja.find((item) => item.acao === 'aparencias_arquivo').campos, ['login.imagemFundoUrl']);
  });
});

test('rota do Admin: GET e PUT da animacao padrao, com N e M para a janela e auditoria', async () => {
  await comRotas(async ({ chamar, banco }) => {
    const antes = await (await chamar('GET', '/api/admin/aparencia-padrao-abertura')).json();
    assert.deepEqual(antes.data, { nome: null, animacaoUrl: null, lojas: 2, comAnimacaoPropria: 2 });
    const corpo = { conteudoBase64: base64(json(LOTTIE)), tipoArquivo: 'application/json', nome: 'carregando-mobile.json' };
    assert.equal((await chamar('PUT', '/api/admin/aparencia-padrao-abertura', { ...corpo, extra: 1 })).status, 400);
    assert.equal((await chamar('PUT', '/api/admin/aparencia-padrao-abertura', { ...corpo, conteudoBase64: base64(json({ a: 1 })) })).status, 400);
    const ok = await chamar('PUT', '/api/admin/aparencia-padrao-abertura', { ...corpo, incluirAnimacaoPropria: true });
    assert.equal(ok.status, 200);
    const dados = (await ok.json()).data;
    assert.equal(dados.lojasAlteradas, 4);
    assert.equal(dados.lojasComAnimacaoPropria, 2);
    assert.equal(dados.nome, 'carregando-mobile.json');
    assert.equal(dados.lojasLimpas, undefined, 'a lista de lojas fica so na auditoria');
    await esperarAuditoria();
    const registro = [...banco.docs.entries()].map(([, d]) => d).find((d) => d.acao === 'animacao_padrao_abertura' && d.status === 200);
    assert.ok(registro, 'auditoria da troca');
    const depois = await (await chamar('GET', '/api/admin/aparencia-padrao-abertura')).json();
    assert.deepEqual([depois.data.lojas, depois.data.comAnimacaoPropria], [4, 0]);
  });
});

test('rota do lojista: nao grava nenhum bloco da jornada nem envia os arquivos dela', async () => {
  await comRotas(async ({ chamar, banco }) => {
    assert.equal((await chamar('PATCH', '/api/loja/aparencia/ofertas/fundo', { boasVindas: { titulo: 'x' } }, 'uid-dono')).status, 400);
    const arquivo = await chamar('POST', '/api/loja/aparencia/ofertas/fundo/arquivos/login-fundo', { conteudoBase64: base64(svg(10, 10)), tipoArquivo: 'image/svg+xml' }, 'uid-dono');
    assert.ok(arquivo.status >= 400);
    assert.equal(banco.dados(LOJA).boasVindas, undefined);
    assert.equal(banco.dados(LOJA).login, undefined);
  });
});

test('padroesDoBloco: os blocos do contrato e so eles', () => {
  assert.deepEqual(Object.keys(BLOCOS_DA_JORNADA), ['primeiraTela', 'abertura', 'boasVindas', 'login', 'codigoSms', 'folhaNome', 'folhaEndereco']);
  assert.equal(padroesDoBloco('abertura').tempoMinimo, 1.5);
});
