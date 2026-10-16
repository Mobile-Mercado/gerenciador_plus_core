import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { BannersDaLoja, camposDoBanner, documentoRest } from '../src/application/loja/BannersDaLoja.js';

// A5 (13/10/2026): banner gravado como o app gerenciador grava, com image.size em decimal.
function restEmMemoria() {
  const documentos = new Map();
  return {
    documentos,
    gravar: async (caminho, documento, opcoes) => {
      if (opcoes.criar && documentos.has(caminho)) throw new Error('ja existe');
      const atual = documentos.get(caminho) || { fields: {} };
      const fields = opcoes.mascara
        ? { ...atual.fields, ...Object.fromEntries(opcoes.mascara.map((campo) => [campo, documento.fields[campo]]).filter(([, valor]) => valor)) }
        : documento.fields;
      documentos.set(caminho, { fields });
    },
    ler: async (caminho) => documentos.get(caminho) || null,
  };
}

const bucket = () => ({ name: 'b', apagados: [], file(caminho) { const dono = this; return { save: async () => {}, delete: async () => { dono.apagados.push(caminho); } }; } });

test('documento REST: largura e altura em doubleValue, datas em timestamp e produtos vazios', () => {
  const doc = documentoRest(camposDoBanner({
    id: 'b1', path: 'https://x', storageRef: 'estabelecimentos/l/banners/1.jpg', largura: 1080, altura: 500,
    inicio: new Date('2026-10-13T00:00:00Z'), fim: new Date('2026-10-19T00:00:00Z'), tipo: 'principal', products: [], novo: true,
  }));
  assert.deepEqual(doc.fields.image.mapValue.fields.size.mapValue.fields, { width: { doubleValue: 1080 }, height: { doubleValue: 500 } });
  assert.deepEqual(doc.fields.products, { arrayValue: {} });
  assert.equal(doc.fields.startAt.timestampValue, '2026-10-13T00:00:00.000Z');
  assert.equal(doc.fields.status.booleanValue, true);
  assert.equal(doc.fields.started.booleanValue, true);
  assert.equal(doc.fields.type.stringValue, 'principal');
});

test('criar e editar: le de volta e confirma doubleValue; edicao mantem tipo e produtos e apaga o arquivo antigo', async () => {
  const rest = restEmMemoria();
  const armazenamento = bucket();
  const firestore = { doc: (caminho) => ({ get: async () => ({ exists: rest.documentos.has(caminho), data: () => ({ type: 'posVertical', products: [{ id: 'p1' }], image: { storageRef: 'antigo.jpg' } }) }) }) };
  let relogio = 1;
  const banners = new BannersDaLoja({ firestore, bucket: armazenamento, restFirestore: rest, novoId: () => 'b1', agora: () => relogio++ });
  const foto = await sharp({ create: { width: 1080, height: 500, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  const criado = await banners.criar('loja-1', foto, { inicio: '2026-10-13T00:00:00Z', fim: '2026-10-19T00:00:00Z' });
  assert.deepEqual(criado.tipos, { width: 'doubleValue', height: 'doubleValue' });
  const editado = await banners.editar('loja-1', 'b1', foto, { inicio: '2026-10-14T00:00:00Z', fim: '2026-10-20T00:00:00Z' });
  assert.equal(editado.largura, 1080);
  const campos = rest.documentos.get('estabelecimentos/loja-1/Banners/b1').fields;
  assert.equal(campos.type.stringValue, 'posVertical');
  assert.deepEqual(armazenamento.apagados, ['antigo.jpg']);
});

test('recusas: imagem sem tamanho legivel, tamanho diferente de 1080x500 e periodo invertido', async () => {
  const banners = new BannersDaLoja({ firestore: {}, bucket: bucket(), restFirestore: restEmMemoria() });
  const periodo = { inicio: '2026-10-13T00:00:00Z', fim: '2026-10-19T00:00:00Z' };
  await assert.rejects(banners.criar('l', Buffer.from('texto'), periodo), (erro) => erro.code === 'banner_sem_tamanho');
  const pequena = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#000' } }).jpeg().toBuffer();
  await assert.rejects(banners.criar('l', pequena, periodo), (erro) => erro.code === 'banner_tamanho_errado');
  const certa = await sharp({ create: { width: 1080, height: 500, channels: 3, background: '#000' } }).jpeg().toBuffer();
  await assert.rejects(banners.criar('l', certa, { inicio: periodo.fim, fim: periodo.inicio }), (erro) => erro.code === 'banner_periodo_invalido');
});

test('C2.1: editar deixa status e started como estao; so a criacao grava os dois em true', async () => {
  const rest = restEmMemoria();
  const firestore = { doc: (caminho) => ({ get: async () => ({ exists: rest.documentos.has(caminho), data: () => ({ type: 'principal', products: [] }) }) }) };
  const banners = new BannersDaLoja({ firestore, bucket: bucket(), restFirestore: rest, novoId: () => 'b1' });
  const foto = await sharp({ create: { width: 1080, height: 500, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  await banners.criar('loja-1', foto, { inicio: '2026-10-13T00:00:00Z', fim: '2026-10-19T00:00:00Z' });
  const caminho = 'estabelecimentos/loja-1/Banners/b1';
  assert.equal(rest.documentos.get(caminho).fields.status.booleanValue, true);
  assert.equal(rest.documentos.get(caminho).fields.started.booleanValue, true);
  // Lojista pausou o banner (status false, started false); a edicao troca imagem e periodo e nao religa.
  rest.documentos.get(caminho).fields.status = { booleanValue: false };
  rest.documentos.get(caminho).fields.started = { booleanValue: false };
  await banners.editar('loja-1', 'b1', foto, { inicio: '2026-10-14T00:00:00Z', fim: '2026-10-20T00:00:00Z' });
  const campos = rest.documentos.get(caminho).fields;
  assert.equal(campos.status.booleanValue, false);
  assert.equal(campos.started.booleanValue, false);
  assert.equal(campos.startAt.timestampValue, '2026-10-14T00:00:00.000Z');
  const semAtivacao = documentoRest(camposDoBanner({ id: 'b1', path: 'x', storageRef: 'y', largura: 1080, altura: 500, inicio: new Date(), fim: new Date(), tipo: 'principal' }));
  assert.equal('status' in semAtivacao.fields, false);
  assert.equal('started' in semAtivacao.fields, false);
});

// Parte 7 (15/10/2026): banner agendado so aparece na data de inicio. O app do cliente le status == true
// sem olhar startAt; inicio no futuro grava status false e aguardandoInicio true ate a rotina ligar.
const AGORA = Date.parse('2026-10-15T12:00:00Z');
const NO_PASSADO = '2026-10-14T00:00:00Z';
const NO_FUTURO = '2026-10-18T00:00:00Z';
const FIM = '2026-10-25T00:00:00Z';
const fotoCerta = () => sharp({ create: { width: 1080, height: 500, channels: 3, background: '#fff' } }).jpeg().toBuffer();
const ligacaoGravada = (rest, caminho) => {
  const campos = rest.documentos.get(caminho).fields;
  return Object.fromEntries(['status', 'started', 'aguardandoInicio'].filter((campo) => campo in campos).map((campo) => [campo, campos[campo].booleanValue]));
};

test('7.1 criar: inicio no futuro grava status false, started false e aguardandoInicio true; inicio passado, como hoje', async () => {
  const rest = restEmMemoria();
  let id = 0;
  const banners = new BannersDaLoja({ firestore: {}, bucket: bucket(), restFirestore: rest, novoId: () => `b${++id}`, agora: () => AGORA });
  const foto = await fotoCerta();
  await banners.criar('loja-1', foto, { inicio: NO_FUTURO, fim: FIM });
  assert.deepEqual(ligacaoGravada(rest, 'estabelecimentos/loja-1/Banners/b1'), { status: false, started: false, aguardandoInicio: true });
  await banners.criar('loja-1', foto, { inicio: NO_PASSADO, fim: FIM });
  assert.deepEqual(ligacaoGravada(rest, 'estabelecimentos/loja-1/Banners/b2'), { status: true, started: true });
});

test('7.2 editar: agendamento e religacao pela situacao de antes; pausado continua pausado', async () => {
  const foto = await fotoCerta();
  const editarCom = async (antes, inicio) => {
    const rest = restEmMemoria();
    const caminho = 'estabelecimentos/loja-1/Banners/b1';
    rest.documentos.set(caminho, { fields: Object.fromEntries(Object.entries(antes).map(([campo, valor]) => [campo, { booleanValue: valor }])) });
    const dados = { type: 'principal', products: [], startAt: new Date(NO_PASSADO), endAt: new Date(FIM), ...antes };
    if (antes.aguardandoInicio === true) dados.startAt = new Date(NO_FUTURO);
    const firestore = { doc: () => ({ get: async () => ({ exists: true, data: () => dados }) }) };
    const banners = new BannersDaLoja({ firestore, bucket: bucket(), restFirestore: rest, agora: () => AGORA });
    await banners.editar('loja-1', 'b1', foto, { inicio, fim: FIM });
    return ligacaoGravada(rest, caminho);
  };
  // No app e o novo inicio ficou no futuro: passa a aguardar.
  assert.deepEqual(await editarCom({ status: true, started: true }, NO_FUTURO), { status: false, started: false, aguardandoInicio: true });
  // No app e o novo inicio ja passou: fica como esta.
  assert.deepEqual(await editarCom({ status: true, started: true }, NO_PASSADO), { status: true, started: true });
  // Aguardando e o novo inicio ja passou: liga.
  assert.deepEqual(await editarCom({ status: false, started: false, aguardandoInicio: true }, NO_PASSADO), { status: true, started: true, aguardandoInicio: false });
  // Aguardando e o novo inicio continua no futuro: continua aguardando.
  assert.deepEqual(await editarCom({ status: false, started: false, aguardandoInicio: true }, NO_FUTURO), { status: false, started: false, aguardandoInicio: true });
  // Pausado continua pausado, com o inicio no futuro ou no passado.
  assert.deepEqual(await editarCom({ status: false, started: true, aguardandoInicio: false }, NO_FUTURO), { status: false, started: true, aguardandoInicio: false });
  assert.deepEqual(await editarCom({ status: false, started: false }, NO_PASSADO), { status: false, started: false });
});

// 7.6 Pausar e Retomar pela rota, com a mesma permissao de editar banner (settings.edit).
async function subirRotaDeBanners({ dados, chaves }) {
  const express = (await import('express')).default;
  const { createBannersDaLojaRoutes } = await import('../src/http/routes/bannersDaLojaRoutes.js');
  const { createPermissionGuard } = await import('../src/http/middlewares/requirePermission.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const rest = restEmMemoria();
  const lidos = [];
  const firestore = { doc: (caminho) => ({ get: async () => { lidos.push(caminho); return { exists: Boolean(dados), data: () => dados }; } }) };
  const bannersDaLoja = new BannersDaLoja({ firestore, bucket: bucket(), restFirestore: rest, agora: () => AGORA });
  const accessRepository = {
    findAccountByClaims: async () => ({
      hasEstablishment: true, establishmentId: 'loja-1', establishmentDocument: {}, permissions: { isAdmin: false, groupId: 'g', keys: chaves },
    }),
  };
  const { requirePermission, accountForRequest } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'u1' }; next(); });
  app.use('/api/loja/banners', createBannersDaLojaRoutes({ bannersDaLoja, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/loja/banners`;
  const mudar = async (acao, bannerId = 'b1') => {
    const resposta = await fetch(`${base}/${bannerId}/situacao`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer t-${Math.random()}` }, body: JSON.stringify({ acao }),
    });
    return { status: resposta.status, corpo: await resposta.json() };
  };
  return { rest, lidos, mudar, fechar: () => new Promise((resolve) => { servidor.close(resolve); }) };
}

test('7.6 rota: pausar, retomar agendado e retomar comecado; encerrado sem acao', async () => {
  const caminho = 'estabelecimentos/loja-1/Banners/b1';
  const casos = [
    { dados: { status: true, started: true, startAt: new Date(NO_PASSADO), endAt: new Date(FIM) }, acao: 'pausar', campos: { status: false, aguardandoInicio: false }, situacao: 'pausado' },
    { dados: { status: false, started: false, aguardandoInicio: false, startAt: new Date(NO_FUTURO), endAt: new Date(FIM) }, acao: 'retomar', campos: { status: false, started: false, aguardandoInicio: true }, situacao: 'agendado' },
    { dados: { status: false, started: true, aguardandoInicio: false, startAt: new Date(NO_PASSADO), endAt: new Date(FIM) }, acao: 'retomar', campos: { status: true, started: true, aguardandoInicio: false }, situacao: 'noApp' },
  ];
  for (const caso of casos) {
    const rota = await subirRotaDeBanners({ dados: caso.dados, chaves: ['settings.edit'] });
    try {
      const { status, corpo } = await rota.mudar(caso.acao);
      assert.equal(status, 200);
      assert.deepEqual(corpo.data, { id: 'b1', situacao: caso.situacao });
      assert.deepEqual(ligacaoGravada(rota.rest, caminho), caso.campos);
      assert.deepEqual(rota.lidos, [caminho]);
    } finally {
      await rota.fechar();
    }
  }
  const encerrado = await subirRotaDeBanners({ dados: { status: true, started: true, startAt: new Date('2026-10-01T00:00:00Z'), endAt: new Date(NO_PASSADO) }, chaves: ['settings.edit'] });
  try {
    for (const acao of ['pausar', 'retomar']) {
      const { status, corpo } = await encerrado.mudar(acao);
      assert.equal(status, 409);
      assert.equal(corpo.error.code, 'banner_encerrado');
    }
    assert.equal(encerrado.rest.documentos.size, 0);
    assert.equal((await encerrado.mudar('apagar')).status, 400);
  } finally {
    await encerrado.fechar();
  }
});

test('7.6 rota: sem settings.edit recusa com 403 e nao le nem grava o banner', async () => {
  const rota = await subirRotaDeBanners({ dados: { status: true, startAt: new Date(NO_PASSADO), endAt: new Date(FIM) }, chaves: ['products.edit'] });
  try {
    const { status, corpo } = await rota.mudar('pausar');
    assert.equal(status, 403);
    assert.equal(corpo.error.code, 'permission_denied');
    assert.equal(corpo.error.key, 'settings.edit');
    assert.deepEqual(rota.lidos, []);
    assert.equal(rota.rest.documentos.size, 0);
  } finally {
    await rota.fechar();
  }
  const semBanner = await subirRotaDeBanners({ dados: null, chaves: ['settings.edit'] });
  try {
    assert.equal((await semBanner.mudar('pausar')).status, 404);
  } finally {
    await semBanner.fechar();
  }
});
