import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { ConjuntosDeIcones } from '../src/application/admin/ConjuntosDeIcones.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola B56-04, conjuntos de icones (parte 2), na branch icones-conjuntos (cola B56-16): os testes dos
// conjuntos da test/Aparencias.test.js da build-56, sem os de Ofertas, Abertura e Primeira tela.
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
    [LOJA]: { name: 'Loja 1', ...loja },
    'estabelecimentos/loja-2': { name: 'Loja 2' },
    'estabelecimentos/loja-3': { name: 'Loja 3' },
    'categoriasProdutos/bebidas': { name: 'Bebidas', icon: 'https://padrao/bebidas.svg' },
    'categoriasProdutos/mercearia': { name: 'Mercearia', icon: 'https://padrao/mercearia.svg' },
    'categoriasProdutos/sem_icone': { name: 'Sem ícone', icon: '' },
    ...extras,
  });
  const armazenamento = bucket();
  let relogio = 1000;
  const comuns = { firestore: banco, bucket: armazenamento, serverTimestamp: () => AGORA, agora: () => relogio++ };
  return { banco, armazenamento, conjuntos: new ConjuntosDeIcones(comuns) };
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

// ----- Rotas -----
async function comRotas(usar, loja = {}) {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { createAdminAuditMiddleware } = await import('../src/http/middlewares/adminAudit.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const contexto = montar(loja, { 'conjuntosIcones/ilus': { nome: 'Ilustrações', icones: {} } });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((request, _response, next) => { request.auth = { uid: request.headers['x-uid'] || 'admin-1', email: 'admin@x' }; next(); });
  app.use('/api/admin', createAdminAuditMiddleware({ firestore: contexto.banco, serverTimestamp: () => AGORA }),
    createAdminRoutes({ conjuntosDeIcones: contexto.conjuntos }));
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
