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
