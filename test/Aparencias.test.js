import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { ConjuntosDeIcones } from '../src/application/admin/ConjuntosDeIcones.js';
import { AparenciaDaLoja } from '../src/application/loja/AparenciaDaLoja.js';
import { padroesDoBloco } from '../src/domain/loja/primeiroAcesso.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola B56-04: conjuntos de icones (parte 2) e Ofertas, Abertura e Primeira tela (parte 3).
const LOJA = 'estabelecimentos/loja-1';
const AGORA = new Date('2026-11-06T12:00:00Z');

function bucket() {
  return {
    name: 'b',
    salvos: [],
    file(caminho) {
      const dono = this;
      return { save: async (conteudo, opcoes) => { dono.salvos.push({ caminho, bytes: conteudo.length, contentType: opcoes.contentType }); } };
    },
  };
}

function montar(loja = {}, extras = {}) {
  const banco = new FirestoreEmMemoria({
    [LOJA]: { name: 'Loja 1', offerColor: '#ff0000', splashImageUrl: 'https://splash/antiga.webp', ...loja },
    'estabelecimentos/loja-2': { name: 'Loja 2' },
    'estabelecimentos/loja-3': { name: 'Loja 3' },
    'categoriasProdutos/bebidas': { name: 'Bebidas', icon: 'https://padrao/bebidas.svg' },
    'categoriasProdutos/mercearia': { name: 'Mercearia', icon: 'https://padrao/mercearia.svg' },
    'categoriasProdutos/sem_icone': { name: 'Sem ícone', icon: '' },
    ...Object.fromEntries(Object.entries(extras).filter(([chave]) => chave !== '__travados')),
  });
  const armazenamento = bucket();
  let relogio = 1000;
  const comuns = { firestore: banco, bucket: armazenamento, serverTimestamp: () => AGORA, agora: () => relogio++, arquivosTravados: extras.__travados ?? [] };
  return { banco, armazenamento, conjuntos: new ConjuntosDeIcones(comuns), aparencia: new AparenciaDaLoja(comuns) };
}

const png = (lado, ruido = false) => {
  if (!ruido) return sharp({ create: { width: lado, height: lado, channels: 4, background: '#0a0' } }).png().toBuffer();
  const pixels = randomBytes(lado * lado * 4);
  return sharp(pixels, { raw: { width: lado, height: lado, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
};
const base64 = (buffer) => Buffer.from(buffer).toString('base64');
const svg = (largura, altura, extra = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}" viewBox="0 0 ${largura} ${altura}"><rect width="10" height="10"/>${extra}</svg>`);

// ----- Parte 2: conjuntos de icones -----

test('conjuntos: Lineares (a lista padrao, sem documento) vem primeiro; cada conjunto com o numero de lojas que o usa', async () => {
  const { conjuntos, banco } = montar({}, {
    'conjuntosIcones/ilus': { nome: 'Ilustrações', icones: { bebidas: { url: 'u', arquivo: 'a' } } },
    'conjuntosIcones/agua': { nome: 'Aquarela', icones: {} },
  });
  await banco.collection('estabelecimentos').doc('loja-2').update({ 'aparencia.conjuntoIcones': 'ilus' });
  const lista = await conjuntos.listar();
  assert.deepEqual(lista.map((item) => [item.id, item.nome, item.lojas, item.icones]), [
    ['lineares', 'Lineares', 2, 2],
    ['agua', 'Aquarela', 0, 0],
    ['ilus', 'Ilustrações', 1, 1],
  ]);
  assert.equal(lista[0].listaPadrao, true);
  assert.equal(banco.dados('conjuntosIcones/lineares'), undefined, 'Lineares nao cria documento');
});

test('conjuntos: criar e renomear; nome repetido (sem acento e caixa) e "Lineares" recusados', async () => {
  const { conjuntos, banco } = montar();
  const criado = await conjuntos.criar({ nome: '  Ilustrações  ' }, { uid: 'admin-1' });
  assert.equal(criado.nome, 'Ilustrações');
  const dados = banco.dados(`conjuntosIcones/${criado.id}`);
  assert.deepEqual(dados, { nome: 'Ilustrações', icones: {}, criadoEm: AGORA, atualizadoEm: AGORA, atualizadoPor: 'admin-1' });
  await assert.rejects(conjuntos.criar({ nome: 'ILUSTRACOES' }), (erro) => erro.code === 'conjunto_nome_repetido');
  await assert.rejects(conjuntos.criar({ nome: 'lineares' }), (erro) => erro.code === 'conjunto_nome_repetido');
  await assert.rejects(conjuntos.criar({ nome: '   ' }), (erro) => erro.code === 'conjunto_nome_invalido');
  const renomeado = await conjuntos.renomear(criado.id, { nome: 'Desenhos' }, { uid: 'admin-2' });
  assert.equal(renomeado.antes, 'Ilustrações');
  assert.equal(banco.dados(`conjuntosIcones/${criado.id}`).nome, 'Desenhos');
  assert.equal(banco.dados(`conjuntosIcones/${criado.id}`).atualizadoPor, 'admin-2');
  await assert.rejects(conjuntos.renomear('lineares', { nome: 'X' }), (erro) => erro.code === 'conjunto_lineares_fixo');
  await assert.rejects(conjuntos.renomear('nao-existe', { nome: 'X' }), (erro) => erro.code === 'conjunto_nao_encontrado');
});

test('icone do conjunto: SVG, PNG ou WEBP quadrado ate 20 KB vai para conjuntosIcones/{id}/ e grava icones.{categoria}', async () => {
  const { conjuntos, banco, armazenamento } = montar({}, { 'conjuntosIcones/ilus': { nome: 'Ilustrações', icones: {} } });
  const resultado = await conjuntos.trocarIcone('ilus', 'bebidas', { conteudoBase64: base64(svg(48, 48)), tipoArquivo: 'image/svg+xml' }, { uid: 'admin-1' });
  assert.equal(resultado.convertido, false);
  const icone = banco.dados('conjuntosIcones/ilus').icones.bebidas;
  assert.equal(icone.arquivo, 'bebidas_1000.svg');
  assert.match(icone.url, /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/b\/o\/conjuntosIcones%2Filus%2Fbebidas_1000\.svg\?alt=media&token=/);
  assert.deepEqual(armazenamento.salvos.map((item) => item.caminho), ['conjuntosIcones/ilus/bebidas_1000.svg']);
  await conjuntos.trocarIcone('ilus', 'mercearia', { conteudoBase64: base64(await png(64)), tipoArquivo: 'image/png' });
  const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00f' } }).webp().toBuffer();
  const trocado = await conjuntos.trocarIcone('ilus', 'bebidas', { conteudoBase64: base64(webp), tipoArquivo: 'image/webp' });
  assert.equal(trocado.antes.arquivo, 'bebidas_1000.svg', 'o de antes vai para a auditoria');
  assert.deepEqual(Object.keys(banco.dados('conjuntosIcones/ilus').icones).sort(), ['bebidas', 'mercearia']);
});

test('icone do conjunto: recusas com mensagem clara (tipo, nao quadrado, acima de 20 KB, categoria fora da lista padrao, Lineares)', async () => {
  const { conjuntos } = montar({}, { 'conjuntosIcones/ilus': { nome: 'Ilustrações', icones: {} } });
  const jpg = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#000' } }).jpeg().toBuffer();
  await assert.rejects(conjuntos.trocarIcone('ilus', 'bebidas', { conteudoBase64: base64(jpg), tipoArquivo: 'image/jpeg' }), (erro) => erro.code === 'conjunto_icone_tipo');
  await assert.rejects(
    conjuntos.trocarIcone('ilus', 'bebidas', { conteudoBase64: base64(svg(48, 30)), tipoArquivo: 'image/svg+xml' }),
    (erro) => erro.code === 'conjunto_icone_nao_quadrado' && erro.message === 'O ícone precisa ser quadrado (este tem 48 x 30).',
  );
  const grande = svg(48, 48, `<desc>${'x'.repeat(25 * 1024)}</desc>`);
  await assert.rejects(
    conjuntos.trocarIcone('ilus', 'bebidas', { conteudoBase64: base64(grande), tipoArquivo: 'image/svg+xml' }),
    (erro) => erro.code === 'conjunto_icone_tamanho' && erro.message === 'O ícone tem 26 KB. O limite é 20 KB: reduza o arquivo e envie de novo.',
  );
  await assert.rejects(
    conjuntos.trocarIcone('ilus', 'nao_existe', { conteudoBase64: base64(svg(48, 48)), tipoArquivo: 'image/svg+xml' }),
    (erro) => erro.code === 'conjunto_categoria_nao_encontrada',
  );
  await assert.rejects(
    conjuntos.trocarIcone('lineares', 'bebidas', { conteudoBase64: base64(svg(48, 48)), tipoArquivo: 'image/svg+xml' }),
    (erro) => erro.code === 'conjunto_lineares_fixo',
  );
});

test('icone do conjunto: PNG acima de 20 KB vira WEBP quando cabe; se nem assim cabe, recusa', async () => {
  const { conjuntos, banco } = montar({}, { 'conjuntosIcones/ilus': { nome: 'Ilustrações', icones: {} } });
  const pngGrande = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0a0' } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(pngGrande.length > 20 * 1024);
  const convertido = await conjuntos.trocarIcone('ilus', 'bebidas', { conteudoBase64: base64(pngGrande), tipoArquivo: 'image/png' });
  assert.equal(convertido.convertido, true);
  assert.ok(convertido.bytes <= 20 * 1024);
  assert.match(banco.dados('conjuntosIcones/ilus').icones.bebidas.arquivo, /^bebidas_\d+\.webp$/);
  const ruido = await png(256, true);
  assert.ok(ruido.length > 20 * 1024);
  await assert.rejects(
    conjuntos.trocarIcone('ilus', 'mercearia', { conteudoBase64: base64(ruido), tipoArquivo: 'image/png' }),
    (erro) => erro.code === 'conjunto_icone_tamanho' && /mesmo convertido para WEBP, passou de 20 KB/.test(erro.message),
  );
});

test('icone do conjunto: remover tira so a chave daquela categoria', async () => {
  const { conjuntos, banco } = montar({}, {
    'conjuntosIcones/ilus': { nome: 'Ilustrações', icones: { bebidas: { url: 'u1', arquivo: 'a1' }, mercearia: { url: 'u2', arquivo: 'a2' } } },
  });
  const resultado = await conjuntos.removerIcone('ilus', 'bebidas', { uid: 'admin-1' });
  assert.deepEqual(resultado.antes, { url: 'u1', arquivo: 'a1' });
  assert.deepEqual(banco.dados('conjuntosIcones/ilus').icones, { mercearia: { url: 'u2', arquivo: 'a2' } });
  await assert.rejects(conjuntos.removerIcone('ilus', 'bebidas'), (erro) => erro.code === 'conjunto_icone_ausente');
});

test('conjunto da loja: grava aparencia.conjuntoIcones; null ou "lineares" apaga o campo; conjunto inexistente recusado', async () => {
  const { conjuntos, banco } = montar({ aparencia: { outro: 1 } }, { 'conjuntosIcones/ilus': { nome: 'Ilustrações', icones: {} } });
  const escolhido = await conjuntos.escolherDaLoja('loja-1', 'ilus');
  assert.deepEqual(escolhido, { lojaId: 'loja-1', antes: 'lineares', conjuntoIcones: 'ilus' });
  assert.deepEqual(banco.dados(LOJA).aparencia, { outro: 1, conjuntoIcones: 'ilus' });
  const devolvido = await conjuntos.escolherDaLoja('loja-1', null);
  assert.equal(devolvido.antes, 'ilus');
  assert.deepEqual(banco.dados(LOJA).aparencia, { outro: 1 });
  await conjuntos.escolherDaLoja('loja-1', 'ilus');
  await conjuntos.escolherDaLoja('loja-1', 'lineares');
  assert.equal(banco.dados(LOJA).aparencia.conjuntoIcones, undefined);
  await assert.rejects(conjuntos.escolherDaLoja('loja-1', 'nao-existe'), (erro) => erro.code === 'conjunto_nao_encontrado');
  await assert.rejects(conjuntos.escolherDaLoja('nao-existe', 'ilus'), (erro) => erro.code === 'loja_nao_encontrada');
});

// ----- Parte 3: Ofertas, Abertura e Primeira tela -----

test('colecao padrao (B56-17): marcar uma tira a marca da outra; so uma por vez; aparece na lista e na leitura', async () => {
  const { conjuntos, banco } = montar({}, {
    'conjuntosIcones/ilus': { nome: 'Ilustrações', icones: {} },
    'conjuntosIcones/padrao': { nome: 'Padrão', icones: {}, padrao: true },
  });
  const marcada = await conjuntos.marcarPadrao('ilus', { uid: 'admin-1' });
  assert.equal(marcada.antes, 'padrao');
  assert.equal(marcada.conjunto.padrao, true);
  assert.equal(banco.dados('conjuntosIcones/ilus').padrao, true);
  assert.equal(banco.dados('conjuntosIcones/padrao').padrao, undefined, 'a outra perde a marca');
  const lista = await conjuntos.listar();
  assert.deepEqual(lista.filter((item) => item.padrao).map((item) => item.id), ['ilus'], 'so uma padrao na lista');
  assert.equal((await conjuntos.ler('padrao')).padrao, false);
  const deNovo = await conjuntos.marcarPadrao('ilus');
  assert.equal(deNovo.antes, 'ilus', 'marcar a que ja e padrao nao muda nada');
  assert.equal(banco.dados('conjuntosIcones/ilus').padrao, true);
  await assert.rejects(conjuntos.marcarPadrao('lineares'), (erro) => erro.code === 'conjunto_lineares_fixo');
  await assert.rejects(conjuntos.marcarPadrao('nao-existe'), (erro) => erro.code === 'conjunto_nao_encontrado');
});

test('ofertas: sem ofertas.fundo.cor vale o offerColor; fundo "cor" e lojista sem liberacao por padrao; abertura usa o splashImageUrl', async () => {
  const { aparencia } = montar();
  assert.deepEqual(await aparencia.ler('loja-1'), {
    lojaId: 'loja-1',
    conjuntoIcones: 'lineares',
    ofertas: {
      fundo: { tipo: 'cor', cor: '#FF0000', corVemDoOfferColor: true, imagemUrl: null, animacaoUrl: null },
      cabecalho: { ligado: false, titulo: null, texto: null, imagemUrl: null },
      lojistaPodeTrocarFundo: false,
    },
    // Cola B56-24 (A2): abertura e primeiraTela com os campos novos e os padroes, e os blocos da jornada.
    abertura: {
      tipo: 'imagem', imagemUrl: 'https://splash/antiga.webp', animacaoUrl: null, animacaoPropria: false, cor: null,
      rodapeLigado: true, rodape: 'Powered by: Móbile', rodapeCor: '#FFFFFF', tempoMinimo: 0,
    },
    primeiraTela: padroesDoBloco('primeiraTela'),
    boasVindas: padroesDoBloco('boasVindas'),
    login: padroesDoBloco('login'),
    codigoSms: padroesDoBloco('codigoSms'),
    folhaNome: padroesDoBloco('folhaNome'),
    folhaEndereco: padroesDoBloco('folhaEndereco'),
    aberturaPadrao: { nome: null, animacaoUrl: null },
  });
});

test('aparencias pelo Admin: cada chave gravada sozinha, com o valor de antes; o offerColor fica; null apaga', async () => {
  const { aparencia, banco } = montar({ ofertas: { cabecalho: { titulo: 'Antigo' } } });
  const resultado = await aparencia.salvar('loja-1', {
    ofertas: { fundo: { tipo: 'cor', cor: '#00AA00' }, cabecalho: { ligado: true, titulo: 'Ofertas da semana' }, lojistaPodeTrocarFundo: true },
    abertura: { tipo: 'animacao', cor: '#FFFFFF' },
    primeiraTela: { cor: '#000000' },
  });
  assert.deepEqual(resultado.campos, [
    'ofertas.fundo.tipo', 'ofertas.fundo.cor', 'ofertas.cabecalho.ligado', 'ofertas.cabecalho.titulo', 'ofertas.lojistaPodeTrocarFundo',
    'abertura.tipo', 'abertura.cor', 'primeiraTela.cor',
  ]);
  assert.equal(resultado.antes['ofertas.cabecalho.titulo'], 'Antigo');
  assert.equal(resultado.antes['ofertas.fundo.cor'], null);
  const loja = banco.dados(LOJA);
  assert.equal(loja.offerColor, '#ff0000', 'offerColor nao muda');
  assert.equal(loja.splashImageUrl, 'https://splash/antiga.webp');
  assert.equal(resultado.aparencia.ofertas.fundo.cor, '#00AA00');
  assert.equal(resultado.aparencia.ofertas.fundo.corVemDoOfferColor, false);
  await aparencia.salvar('loja-1', { ofertas: { fundo: { cor: null } } });
  assert.equal((await aparencia.ler('loja-1')).ofertas.fundo.cor, '#FF0000', 'sem ofertas.fundo.cor, volta o offerColor');
  await assert.rejects(aparencia.salvar('loja-1', {}), (erro) => erro.code === 'aparencia_sem_mudancas');
});

test('fundo de Ofertas pelo lojista: so com lojistaPodeTrocarFundo ligado e so ofertas.fundo', async () => {
  const { aparencia, banco } = montar();
  await assert.rejects(aparencia.salvar('loja-1', { ofertas: { fundo: { tipo: 'cor' } } }, { soFundo: true }), (erro) => erro.code === 'ofertas_fundo_travado' && erro.statusCode === 403);
  await aparencia.salvar('loja-1', { ofertas: { lojistaPodeTrocarFundo: true } });
  await aparencia.salvar('loja-1', { ofertas: { fundo: { tipo: 'cor', cor: '#123456' } } }, { soFundo: true });
  assert.equal(banco.dados(LOJA).ofertas.fundo.cor, '#123456');
  await assert.rejects(aparencia.salvar('loja-1', { ofertas: { cabecalho: { ligado: true } } }, { soFundo: true }), (erro) => erro.code === 'ofertas_so_fundo');
  await assert.rejects(aparencia.salvar('loja-1', { abertura: { tipo: 'imagem' } }, { soFundo: true }), (erro) => erro.code === 'ofertas_so_fundo');
});

test('arquivos: imagem ate 40 KB e animacao .json ate 120 KB; abertura-imagem grava o splashImageUrl; acima, recusa', async () => {
  const { aparencia, banco, armazenamento } = montar();
  const imagem = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } }).webp().toBuffer();
  const abertura = await aparencia.enviarArquivo('loja-1', 'abertura-imagem', { conteudoBase64: base64(imagem), tipoArquivo: 'image/webp' });
  assert.deepEqual(abertura.campos, ['splashImageUrl']);
  assert.deepEqual(abertura.antes, { splashImageUrl: 'https://splash/antiga.webp' });
  assert.match(banco.dados(LOJA).splashImageUrl, /appMobile%2FcompanyImages%2Floja-1%2Faparencia%2Fabertura-imagem_\d+\.webp/);
  assert.equal(banco.dados(LOJA).abertura, undefined, 'sem abertura.imagemUrl duplicado');
  const lottie = Buffer.from(JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 60, w: 200, h: 200, layers: [] }));
  await aparencia.enviarArquivo('loja-1', 'abertura-animacao', { conteudoBase64: base64(lottie), tipoArquivo: 'application/json' });
  assert.match(banco.dados(LOJA).abertura.animacaoUrl, /abertura-animacao_\d+\.json/);
  await aparencia.enviarArquivo('loja-1', 'primeira-tela-logo', { conteudoBase64: base64(svg(64, 64)), tipoArquivo: 'image/svg+xml' });
  assert.ok(banco.dados(LOJA).primeiraTela.logoUrl);
  assert.equal(armazenamento.salvos.find((item) => item.caminho.endsWith('.json')).contentType, 'application/json');

  const imagemGrande = Buffer.concat([svg(64, 64), Buffer.alloc(41 * 1024, 32)]);
  await assert.rejects(
    aparencia.enviarArquivo('loja-1', 'ofertas-cabecalho-imagem', { conteudoBase64: base64(imagemGrande), tipoArquivo: 'image/svg+xml' }),
    (erro) => erro.code === 'aparencia_imagem_tamanho' && erro.message === 'A imagem tem 42 KB. O limite é 40 KB: reduza o arquivo e envie de novo.',
  );
  const animacaoGrande = Buffer.from(JSON.stringify({ v: '5', d: 'x'.repeat(121 * 1024) }));
  await assert.rejects(
    aparencia.enviarArquivo('loja-1', 'abertura-animacao', { conteudoBase64: base64(animacaoGrande), tipoArquivo: 'application/json' }),
    (erro) => erro.code === 'aparencia_animacao_tamanho',
  );
  await assert.rejects(
    aparencia.enviarArquivo('loja-1', 'abertura-animacao', { conteudoBase64: base64(Buffer.from('{nao e json')), tipoArquivo: 'application/json' }),
    (erro) => erro.code === 'aparencia_animacao_invalida',
  );
  await assert.rejects(
    aparencia.enviarArquivo('loja-1', 'abertura-animacao', { conteudoBase64: base64(lottie), tipoArquivo: 'text/plain' }),
    (erro) => erro.code === 'aparencia_animacao_tipo',
  );
});

test('arquivos pelo lojista: so os do fundo e so liberado', async () => {
  const { aparencia, banco } = montar();
  const imagem = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).webp().toBuffer();
  const entrada = { conteudoBase64: base64(imagem), tipoArquivo: 'image/webp' };
  await assert.rejects(aparencia.enviarArquivo('loja-1', 'ofertas-fundo-imagem', entrada, { soFundo: true }), (erro) => erro.code === 'ofertas_fundo_travado');
  await aparencia.salvar('loja-1', { ofertas: { lojistaPodeTrocarFundo: true } });
  await aparencia.enviarArquivo('loja-1', 'ofertas-fundo-imagem', entrada, { soFundo: true });
  assert.ok(banco.dados(LOJA).ofertas.fundo.imagemUrl);
  await assert.rejects(aparencia.enviarArquivo('loja-1', 'abertura-imagem', entrada, { soFundo: true }), (erro) => erro.code === 'ofertas_so_fundo');
});

// ----- Rotas -----
async function comRotas(usar, loja = {}) {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { createAparenciaDaLojaRoutes } = await import('../src/http/routes/aparenciaDaLojaRoutes.js');
  const { createAdminAuditMiddleware } = await import('../src/http/middlewares/adminAudit.js');
  const { createPermissionGuard } = await import('../src/http/middlewares/requirePermission.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const contexto = montar(loja, { 'conjuntosIcones/ilus': { nome: 'Ilustrações', icones: {} } });
  const contas = {
    'uid-dono': { establishmentId: 'loja-1', permissions: { isAdmin: true, groupId: null, keys: [] } },
    'uid-func': { establishmentId: 'loja-1', permissions: { isAdmin: false, groupId: 'g', keys: ['requests.view'] } },
  };
  const { requirePermission, accountForRequest } = createPermissionGuard({
    accessRepository: { findAccountByClaims: async ({ uid }) => ({ hasEstablishment: true, establishmentDocument: {}, ...contas[uid] }) },
  });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((request, _response, next) => { request.auth = { uid: request.headers['x-uid'] || 'admin-1', email: 'admin@x' }; next(); });
  app.use('/api/admin', createAdminAuditMiddleware({ firestore: contexto.banco, serverTimestamp: () => AGORA }),
    createAdminRoutes({ conjuntosDeIcones: contexto.conjuntos, aparenciaDaLoja: contexto.aparencia }));
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

test('rotas do Admin: conjuntos (listar, criar, renomear, icone, remover) e conjunto da loja, com auditoria', async () => {
  await comRotas(async ({ chamar, banco }) => {
    const lista = await (await chamar('GET', '/api/admin/conjuntos-icones')).json();
    assert.deepEqual(lista.data.map((item) => item.id), ['lineares', 'ilus']);
    const criado = await chamar('POST', '/api/admin/conjuntos-icones', { nome: 'Aquarela' });
    assert.equal(criado.status, 201);
    const { id } = (await criado.json()).data;
    assert.equal((await chamar('PATCH', `/api/admin/conjuntos-icones/${id}`, { nome: 'Aquarela 2' })).status, 200);
    assert.equal((await chamar('POST', '/api/admin/conjuntos-icones', { nome: 'ilustracoes' })).status, 409);
    const icone = await chamar('PUT', '/api/admin/conjuntos-icones/ilus/icones/bebidas', { conteudoBase64: base64(svg(48, 48)), tipoArquivo: 'image/svg+xml' });
    assert.equal(icone.status, 200);
    assert.ok((await icone.json()).data.icones.bebidas.url);
    const torto = await chamar('PUT', '/api/admin/conjuntos-icones/ilus/icones/bebidas', { conteudoBase64: base64(svg(48, 20)), tipoArquivo: 'image/svg+xml' });
    assert.equal(torto.status, 400);
    assert.equal((await torto.json()).error.message, 'O ícone precisa ser quadrado (este tem 48 x 20).');
    assert.equal((await chamar('DELETE', '/api/admin/conjuntos-icones/ilus/icones/bebidas')).status, 200);
    assert.equal((await chamar('PATCH', '/api/admin/estabelecimentos/loja-1/conjunto-icones', { conjuntoId: 'ilus' })).status, 200);
    assert.equal(banco.dados(LOJA).aparencia.conjuntoIcones, 'ilus');
    assert.equal((await chamar('PATCH', '/api/admin/estabelecimentos/loja-1/conjunto-icones', { conjuntoId: 'x/y' })).status, 400);
    await esperarAuditoria();
    const registros = [...banco.docs.entries()].filter(([caminho]) => caminho.startsWith('adminAuditLogs/')).map(([, dados]) => dados);
    assert.equal(registros.filter((item) => item.status >= 400).length, 3, 'as recusas tambem ficam registradas');
    const acoes = registros.filter((item) => item.status < 400).map((item) => item.acao);
    assert.deepEqual(acoes.sort(), ['conjunto_icone_removido', 'conjunto_icone_trocado', 'conjunto_icones_criado', 'conjunto_icones_da_loja', 'conjunto_icones_renomeado'].sort());
    const naLoja = [...banco.docs.entries()].filter(([caminho]) => caminho.startsWith(`${LOJA}/AdminAuditLogs/`)).map(([, dados]) => dados.details);
    assert.equal(naLoja.length, 1);
    assert.deepEqual([naLoja[0].acao, naLoja[0].antes, naLoja[0].depois], ['conjunto_icones_da_loja', 'lineares', 'ilus']);
  });
});

test('rotas do Admin: aparencias com o valor de antes na auditoria; campos fora do contrato e cor fora do formato recusados', async () => {
  await comRotas(async ({ chamar, banco }) => {
    const caminho = '/api/admin/estabelecimentos/loja-1/aparencias';
    assert.equal((await chamar('PATCH', caminho, { ofertas: { fundo: { cor: 'vermelho' } } })).status, 400);
    assert.equal((await chamar('PATCH', caminho, { ofertas: { fundo: { tipo: 'video' } } })).status, 400);
    assert.equal((await chamar('PATCH', caminho, { ofertas: { fundo: { imagemUrl: 'https://x' } } })).status, 400, 'URL so pelo envio do arquivo');
    assert.equal((await chamar('PATCH', caminho, { abertura: { imagemUrl: null } })).status, 400, 'a imagem da abertura e o splashImageUrl');
    assert.equal((await chamar('PATCH', caminho, { offerColor: '#000000' })).status, 400);
    const ok = await chamar('PATCH', caminho, { ofertas: { fundo: { cor: '#00aa00' }, lojistaPodeTrocarFundo: true } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data.ofertas.fundo.cor, '#00AA00');
    const animacao = Buffer.from(JSON.stringify({ v: '5', fr: 30, ip: 0, op: 60, w: 200, h: 200, layers: [] }));
    assert.equal((await chamar('POST', `${caminho}/arquivos/abertura-animacao`, { conteudoBase64: base64(animacao), tipoArquivo: 'application/json' })).status, 200);
    assert.equal((await chamar('POST', `${caminho}/arquivos/qualquer`, { conteudoBase64: base64(animacao), tipoArquivo: 'application/json' })).status, 400);
    await esperarAuditoria();
    const naLoja = [...banco.docs.entries()].filter(([c]) => c.startsWith(`${LOJA}/AdminAuditLogs/`)).map(([, dados]) => dados.details);
    const aparencias = naLoja.find((item) => item.acao === 'aparencias');
    assert.deepEqual(aparencias.campos, ['ofertas.fundo.cor', 'ofertas.lojistaPodeTrocarFundo']);
    assert.deepEqual(aparencias.antes, { 'ofertas.fundo.cor': null, 'ofertas.lojistaPodeTrocarFundo': null });
    assert.deepEqual(naLoja.find((item) => item.acao === 'aparencias_arquivo').campos, ['abertura.animacaoUrl']);
  });
});

test('rota do lojista: fundo de Ofertas so com settings.edit e so quando o Admin liberou', async () => {
  await comRotas(async ({ chamar, banco }) => {
    const caminho = '/api/loja/aparencia/ofertas/fundo';
    const travado = await chamar('PATCH', caminho, { tipo: 'cor', cor: '#123456' }, 'uid-dono');
    assert.equal(travado.status, 403);
    assert.equal((await travado.json()).error.code, 'ofertas_fundo_travado');
    await chamar('PATCH', '/api/admin/estabelecimentos/loja-1/aparencias', { ofertas: { lojistaPodeTrocarFundo: true } });
    assert.equal((await chamar('PATCH', caminho, { tipo: 'cor', cor: '#123456' }, 'uid-func')).status, 403, 'sem settings.edit');
    assert.equal((await chamar('PATCH', caminho, { cabecalho: { ligado: true } }, 'uid-dono')).status, 400, 'so o fundo');
    const ok = await chamar('PATCH', caminho, { tipo: 'cor', cor: '#123456' }, 'uid-dono');
    assert.equal(ok.status, 200);
    assert.equal(banco.dados(LOJA).ofertas.fundo.cor, '#123456');
    const imagem = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).webp().toBuffer();
    assert.equal((await chamar('POST', `${caminho}/arquivos/imagem`, { conteudoBase64: base64(imagem), tipoArquivo: 'image/webp' }, 'uid-dono')).status, 200);
    assert.equal((await chamar('POST', `${caminho}/arquivos/logo`, { conteudoBase64: base64(imagem), tipoArquivo: 'image/webp' }, 'uid-dono')).status, 400);
    assert.equal((await (await chamar('GET', '/api/loja/aparencia', undefined, 'uid-func')).json()).data.ofertas.fundo.cor, '#123456', 'ler nao pede chave');
  });
});

test('rota do Admin (B56-17): PUT /conjuntos-icones/:id/padrao marca a colecao padrao, com auditoria', async () => {
  await comRotas(async ({ chamar, banco }) => {
    const marcada = await chamar('PUT', '/api/admin/conjuntos-icones/ilus/padrao');
    assert.equal(marcada.status, 200);
    assert.equal((await marcada.json()).data.padrao, true);
    assert.equal(banco.dados('conjuntosIcones/ilus').padrao, true);
    assert.equal((await chamar('PUT', '/api/admin/conjuntos-icones/nao-existe/padrao')).status, 404);
    const lista = await (await chamar('GET', '/api/admin/conjuntos-icones')).json();
    assert.deepEqual(lista.data.map((item) => [item.id, item.padrao === true]), [['lineares', false], ['ilus', true]]);
    await esperarAuditoria();
    const acoes = [...banco.docs.entries()].filter(([caminho]) => caminho.startsWith('adminAuditLogs/')).map(([, dados]) => [dados.acao, dados.status]);
    assert.ok(acoes.some(([acao, status]) => acao === 'conjunto_icones_padrao' && status === 200));
  });
});

test('rota do Admin (B56-17): GET /estabelecimentos/:lojaId/conjunto-icones diz a colecao da loja (lineares sem escolha)', async () => {
  await comRotas(async ({ chamar }) => {
    assert.deepEqual((await (await chamar('GET', '/api/admin/estabelecimentos/loja-1/conjunto-icones')).json()).data, { lojaId: 'loja-1', conjuntoIcones: 'lineares' });
    await chamar('PATCH', '/api/admin/estabelecimentos/loja-1/conjunto-icones', { conjuntoId: 'ilus' });
    assert.deepEqual((await (await chamar('GET', '/api/admin/estabelecimentos/loja-1/conjunto-icones')).json()).data, { lojaId: 'loja-1', conjuntoIcones: 'ilus' });
    assert.equal((await chamar('GET', '/api/admin/estabelecimentos/nao-existe/conjunto-icones')).status, 404);
  });
});
