import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { BannersNoAdmin, destinoDoBanner, precosDoProduto, produtoAVenda, produtoDoBanner } from '../src/application/admin/BannersNoAdmin.js';
import { documentoRest } from '../src/application/loja/BannersDaLoja.js';
import { createBannersDaLojaRoutes } from '../src/http/routes/bannersDaLojaRoutes.js';
import { createAppDoClienteDaLojaRoutes } from '../src/http/routes/appDoClienteDaLojaRoutes.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';

// Cola B57-07 (19/11): a tela Loja do Gerenciador mexe nos banners por tipo (Principal, Vertical e
// Popup), com os limites e as medidas do Admin, so na propria loja, com a permissao de hoje
// (settings.edit). "Leva para" grava products e category como o app gerenciador.
const AGORA = Date.parse('2026-11-19T15:00:00Z');
const FIM = new Date('2026-11-24T23:59:59Z');

function bancoEmMemoria(documentos) {
  const lidos = [];
  const doc = (caminho) => ({
    id: caminho.split('/').pop(),
    get: async () => {
      lidos.push(caminho);
      const dados = documentos[caminho];
      return { id: caminho.split('/').pop(), exists: dados !== undefined, data: () => dados, ref: { collection: (nome) => colecao(`${caminho}/${nome}`) } };
    },
    collection: (nome) => colecao(`${caminho}/${nome}`),
  });
  // Consultas com where (==, array-contains-any) e select, anotadas em `consultas` (cola B57-10, B1).
  const consultas = [];
  const confere = (dados, [campo, operador, valor]) => {
    if (operador === '==') return dados?.[campo] === valor;
    if (operador === 'array-contains-any') return Array.isArray(dados?.[campo]) && dados[campo].some((item) => valor.includes(item));
    throw new Error(`operador sem fake: ${operador}`);
  };
  const colecao = (caminho, filtros = [], campos = null) => ({
    doc: (id) => doc(`${caminho}/${id}`),
    where: (campo, operador, valor) => colecao(caminho, [...filtros, [campo, operador, valor]], campos),
    select: (...nomes) => colecao(caminho, filtros, nomes),
    get: async () => {
      if (filtros.length || campos) consultas.push({ caminho, filtros, campos });
      return {
        docs: Object.entries(documentos)
          .filter(([chave]) => chave.startsWith(`${caminho}/`) && !chave.slice(caminho.length + 1).includes('/'))
          .filter(([, dados]) => filtros.every((filtro) => confere(dados, filtro)))
          .map(([chave, dados]) => ({ id: chave.split('/').pop(), data: () => (campos ? Object.fromEntries(campos.filter((nome) => nome in dados).map((nome) => [nome, dados[nome]])) : dados) })),
      };
    },
  });
  return { lidos, consultas, firestore: { collection: (nome) => colecao(nome), doc } };
}

// O documento criado passa a existir para a leitura de volta (BannersNoAdmin.ler).
function restEmMemoria(documentos) {
  const gravados = [];
  return {
    projectId: 'proj',
    gravados,
    gravar: async (caminho, documento, opcoes) => {
      gravados.push({ caminho, documento, opcoes });
      if (opcoes.criar) documentos[caminho] = { type: documento.fields.type?.stringValue, status: documento.fields.status?.booleanValue, endAt: FIM };
      // Cola B57-10, B3: o destino gravado passa a valer para a leitura seguinte (destino e Ligado juntos).
      if (opcoes.mascara?.includes('destino') && documentos[caminho]) documentos[caminho] = { ...documentos[caminho], destino: documento.fields.destino?.stringValue ?? null };
    },
    ler: async () => null,
  };
}

async function subir({ documentos, chaves = ['settings.edit'], loja = 'loja-1' }) {
  const { firestore, lidos, consultas } = bancoEmMemoria(documentos);
  const rest = restEmMemoria(documentos);
  const bannersPorTipo = new BannersNoAdmin({
    firestore, bucket: { name: 'b', file: () => ({ save: async () => {}, delete: async () => {} }) }, restFirestore: rest,
    medir: async () => ({ largura: 400, altura: 700 }), agora: () => AGORA, novoId: () => 'novo1',
  });
  const accessRepository = {
    findAccountByClaims: async () => ({ hasEstablishment: true, establishmentId: loja, establishmentDocument: {}, permissions: { isAdmin: false, groupId: 'g', keys: chaves } }),
  };
  const { requirePermission, accountForRequest } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'u1' }; next(); });
  app.use('/api/loja/banners', createBannersDaLojaRoutes({ bannersDaLoja: null, bannersPorTipo, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/loja/banners`;
  const chamar = async (caminho, { method = 'GET', corpo, tipo } = {}) => {
    const headers = { Authorization: `Bearer t-${Math.random()}` };
    let body;
    if (corpo instanceof Uint8Array) { headers['Content-Type'] = tipo || 'image/jpeg'; body = corpo; } else if (corpo !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(corpo); }
    const resposta = await fetch(`${base}${caminho}`, { method, headers, body });
    return { status: resposta.status, corpo: await resposta.json() };
  };
  return { rest, lidos, consultas, chamar, fechar: () => new Promise((resolve) => { servidor.close(resolve); }) };
}

const banner = (tipo, extra = {}) => ({ type: tipo, status: true, started: true, startAt: new Date('2026-11-18T03:00:00Z'), endAt: FIM, image: { path: 'https://x', size: { width: 1080, height: 500 } }, ...extra });

test('B57-07: lista por tipo so Principal, Vertical e Popup, com ligados sobre o limite e o destino', async () => {
  const rota = await subir({
    documentos: {
      'estabelecimentos/loja-1': { coverImageUrl: 'https://capa' },
      'estabelecimentos/loja-1/Banners/p1': banner('principal', { products: [{ id: 'a' }, { id: 'b' }] }),
      'estabelecimentos/loja-1/Banners/v1': banner('vertical', { category: { id: 'c1', name: 'Limpeza' } }),
      'estabelecimentos/loja-1/Banners/x1': banner('posVertical'),
      'estabelecimentos/loja-1/Banners/u1': banner('popup', { status: false, started: false }),
    },
  });
  try {
    const { status, corpo } = await rota.chamar('/por-tipo');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(corpo.data.tipos), ['principal', 'vertical', 'popup']);
    assert.equal(corpo.data.tipos.principal.limite, 5);
    assert.equal(corpo.data.tipos.principal.ocupados, 1);
    assert.equal(corpo.data.tipos.vertical.limite, 10);
    assert.equal(corpo.data.tipos.popup.limite, 1);
    assert.equal(corpo.data.tipos.popup.ocupados, 0);
    assert.deepEqual(corpo.data.tipos.principal.banners[0].levaPara, { tipo: 'produtos', quantos: 2, ids: ['a', 'b'] });
    assert.deepEqual(corpo.data.tipos.vertical.banners[0].levaPara, { tipo: 'categoria', id: 'c1', nome: 'Limpeza' });
    assert.deepEqual(corpo.data.tipos.popup.banners[0].levaPara, { tipo: 'nada' });
    assert.equal(corpo.data.capaUrl, 'https://capa');
  } finally {
    await rota.fechar();
  }
});

test('B57-07: so a propria loja; gravar sem settings.edit recusa com 403 e nao grava', async () => {
  const documentos = { 'estabelecimentos/loja-1': {}, 'estabelecimentos/loja-1/Banners/v1': banner('vertical') };
  const semChave = await subir({ documentos, chaves: [] });
  try {
    assert.equal((await semChave.chamar('/por-tipo/v1', { method: 'PATCH', corpo: { ligado: false } })).status, 403);
    assert.equal((await semChave.chamar('/por-tipo/v1', { method: 'DELETE' })).status, 403);
    assert.equal(semChave.rest.gravados.length, 0);
  } finally {
    await semChave.fechar();
  }
  // Outra loja: o banner v1 da loja-1 nao existe para ela.
  const outra = await subir({ documentos, loja: 'loja-2' });
  try {
    const { status } = await outra.chamar('/por-tipo/v1', { method: 'PATCH', corpo: { ligado: false } });
    assert.equal(status, 404);
    assert.equal(outra.rest.gravados.length, 0);
    assert.ok(outra.lidos.every((caminho) => caminho.startsWith('estabelecimentos/loja-2')));
  } finally {
    await outra.fechar();
  }
});

test('B57-07, itens 3 e 7: "Criar novo" no limite nasce desligado; ligar alem do limite e recusado (409)', async () => {
  const rota = await subir({
    documentos: {
      'estabelecimentos/loja-1': {},
      'estabelecimentos/loja-1/Banners/u1': banner('popup'),
      'estabelecimentos/loja-1/Banners/u2': banner('popup', { status: false, started: false }),
    },
  });
  try {
    const criado = await rota.chamar(`/por-tipo?tipo=popup&inicio=${encodeURIComponent('2026-11-19T15:00:00Z')}&fim=${encodeURIComponent(FIM.toISOString())}`, {
      method: 'POST', corpo: new Uint8Array([1, 2, 3]), tipo: 'image/png',
    });
    assert.equal(criado.status, 201);
    const campos = rota.rest.gravados[0].documento.fields;
    assert.equal(campos.status.booleanValue, false);
    assert.equal(campos.aguardandoInicio.booleanValue, false);
    assert.equal(campos.type.stringValue, 'popup');
    const ligar = await rota.chamar('/por-tipo/u2', { method: 'PATCH', corpo: { ligado: true } });
    assert.equal(ligar.status, 409);
    assert.equal(ligar.corpo.error.code, 'banner_limite');
    assert.equal(rota.rest.gravados.length, 1);
    // "Abaixo do vertical" nao e criado por esta tela.
    const pos = await rota.chamar(`/por-tipo?tipo=posVertical&inicio=a&fim=b`, { method: 'POST', corpo: new Uint8Array([1]) });
    assert.equal(pos.status, 400);
  } finally {
    await rota.fechar();
  }
});

test('B57-07, item 6: "Leva para" grava products com referencias e numeros do app, e a categoria apaga os produtos', async () => {
  const rota = await subir({
    documentos: {
      'estabelecimentos/loja-1': {},
      'estabelecimentos/loja-1/Banners/p1': banner('principal'),
      'estabelecimentos/loja-1/Products/pr1': { name: 'Picanha', barCode: '789', currentPrice: 59.9, previewPrice: 69.9, images: [{ fileName: 'f.jpg', fileUrl: 'https://f', quality: 80 }] },
      'estabelecimentos/loja-1/Products/pr2': { name: 'Banana', currentPrice: 5 },
      'estabelecimentos/loja-1/ProductCategories/c1': { name: 'Limpeza', icon: 'https://i', isActive: true },
      'estabelecimentos/loja-1/ProductSubcategories/s1': { categoryId: 'c1', isActive: true },
      'estabelecimentos/loja-1/Products/pr3': { isActive: true, isTrashed: false, currentPrice: 9.9, shelvesIds: ['c1_s1'] },
    },
  });
  try {
    const produtos = await rota.chamar('/por-tipo/p1', { method: 'PATCH', corpo: { levaPara: { tipo: 'produtos', ids: ['pr1', 'pr2'] } } });
    assert.equal(produtos.status, 200);
    const gravado = rota.rest.gravados.at(-1);
    assert.deepEqual(gravado.opcoes.mascara, ['products', 'category', 'destino'], 'B57-10, B2: o destino sai do documento');
    assert.equal(gravado.documento.fields.destino, undefined);
    const [primeiro, segundo] = gravado.documento.fields.products.arrayValue.values.map((valor) => valor.mapValue.fields);
    assert.equal(primeiro.reference.referenceValue, 'projects/proj/databases/(default)/documents/estabelecimentos/loja-1/Products/pr1');
    assert.equal(primeiro.companyRef.referenceValue, 'projects/proj/databases/(default)/documents/estabelecimentos/loja-1');
    assert.deepEqual(primeiro.itemPrice, { doubleValue: 59.9 });
    assert.deepEqual(primeiro.previewPrice, { doubleValue: 69.9 });
    assert.deepEqual(primeiro.images.arrayValue.values[0].mapValue.fields.quality, { integerValue: '80' });
    assert.deepEqual(primeiro.images.arrayValue.values[0].mapValue.fields.itsFromPlatform, { booleanValue: false });
    // Campo faltando vira o vazio do tipo (barCode texto, previewPrice decimal).
    assert.deepEqual(segundo.barCode, { stringValue: '' });
    assert.deepEqual(segundo.previewPrice, { doubleValue: 5 });
    assert.deepEqual(gravado.documento.fields.category, { nullValue: null });

    await rota.chamar('/por-tipo/p1', { method: 'PATCH', corpo: { levaPara: { tipo: 'categoria', id: 'c1' } } });
    const categoria = rota.rest.gravados.at(-1).documento.fields;
    assert.deepEqual(categoria.products, { arrayValue: {} });
    assert.equal(categoria.category.mapValue.fields.reference.referenceValue, 'projects/proj/databases/(default)/documents/estabelecimentos/loja-1/ProductCategories/c1');
    assert.deepEqual(categoria.category.mapValue.fields.name, { stringValue: 'Limpeza' });

    await rota.chamar('/por-tipo/p1', { method: 'PATCH', corpo: { levaPara: { tipo: 'nada' } } });
    const nada = rota.rest.gravados.at(-1).documento.fields;
    assert.deepEqual(nada, { products: { arrayValue: {} }, category: { nullValue: null } });

    const outroProduto = await rota.chamar('/por-tipo/p1', { method: 'PATCH', corpo: { levaPara: { tipo: 'produtos', ids: ['de-outra-loja'] } } });
    assert.equal(outroProduto.status, 404);
  } finally {
    await rota.fechar();
  }
});

test('B57-07b, item 13 (parte C): encerrados do mais recente ao mais antigo; "Usar de novo" volta desligado, com o periodo de um novo', async () => {
  const rota = await subir({
    documentos: {
      'estabelecimentos/loja-1': {},
      'estabelecimentos/loja-1/Banners/e1': banner('principal', { endAt: new Date('2026-11-07T23:59:59Z') }),
      'estabelecimentos/loja-1/Banners/e2': banner('popup', { endAt: new Date('2026-11-16T23:59:59Z') }),
      'estabelecimentos/loja-1/Banners/e3': banner('posVertical', { endAt: new Date('2026-11-10T23:59:59Z') }),
      'estabelecimentos/loja-1/Banners/v1': banner('vertical'),
    },
  });
  try {
    const { status, corpo } = await rota.chamar('/por-tipo/encerrados');
    assert.equal(status, 200);
    assert.deepEqual(corpo.data.map((item) => item.id), ['e2', 'e1'], 'sem Abaixo do vertical e sem os que nao encerraram');
    const usar = await rota.chamar('/por-tipo/e1/usar-de-novo', { method: 'POST' });
    assert.equal(usar.status, 200);
    const gravado = rota.rest.gravados.at(-1);
    assert.deepEqual(gravado.opcoes.mascara, ['startAt', 'endAt', 'status', 'started', 'aguardandoInicio']);
    assert.equal(gravado.documento.fields.status.booleanValue, false);
    assert.equal(gravado.documento.fields.aguardandoInicio.booleanValue, false);
    assert.equal(gravado.documento.fields.startAt.timestampValue, new Date(AGORA).toISOString());
    assert.equal(gravado.documento.fields.endAt.timestampValue, '2026-12-20T02:59:59.000Z', 'fim do dia de Brasilia daqui a 30 dias');
    const deNovo = await rota.chamar('/por-tipo/v1/usar-de-novo', { method: 'POST' });
    assert.equal(deNovo.status, 409, 'so encerrado');
  } finally {
    await rota.fechar();
  }
});

test('B57-07: destino e produto do banner sao funcoes puras', () => {
  assert.deepEqual(destinoDoBanner({}), { tipo: 'nada' });
  // Fotos como ProductImageAdapter.fromMapItems: sem fileName texto fica de fora; endereco solto vira foto.
  const produto = produtoDoBanner('l', 'p', { name: null, images: [null, { fileName: 7 }, 'https://x/foto.png', { fileName: 'a.jpg' }] });
  assert.equal(produto.name, '');
  assert.deepEqual(produto.images.map((imagem) => imagem.fileName), ['foto.png', 'a.jpg']);
  assert.equal(produto.images[0].folderPath, 'produtosMobile');
  // Precos como o app gerenciador (PromotionValidityMixin): promocao valendo, o promocional e o riscado.
  const agora = Date.parse('2026-11-19T15:00:00Z');
  const emPromocao = { currentPrice: 10, previewPrice: 12, promotionalPrice: 8, promotionStartAt: new Date('2026-11-18T00:00:00Z'), promotionEndAt: new Date('2026-11-20T00:00:00Z') };
  assert.deepEqual(precosDoProduto(emPromocao, agora), { itemPrice: 8, previewPrice: 10 });
  assert.deepEqual(precosDoProduto({ ...emPromocao, promotionEndAt: new Date('2026-11-19T00:00:00Z') }, agora), { itemPrice: 10, previewPrice: 12 });
  assert.deepEqual(precosDoProduto({ currentPrice: 5 }, agora), { itemPrice: 5, previewPrice: 5 });
  assert.deepEqual(precosDoProduto({ currentPrice: 10, promotionalPrice: 11 }, agora), { itemPrice: 10, previewPrice: 10 }, 'promocional acima do atual nao vale');
  assert.throws(() => documentoRest({ r: { __referencia: 'x' } }), /projeto/);
});

test('B57-07, item 9: a loja le a propria Inicio publicada, a tabela das variacoes e os icones', async () => {
  const pedidos = [];
  const appDoClienteDaLoja = { ler: async (loja) => { pedidos.push(['app', loja]); return { lojaId: loja, featureFlags: { retirada: true }, aparenciaHome: { topo: 1, meio: 2, fim: 3, rodape: 2, preposicaoBusca: 'no' }, ajustesDaHome: { topoModelo: null, topoAjustes: null } }; } };
  const aparenciaDaHome = { variacoes: async () => ({ numeros: { topo: 3 } }) };
  const conjuntosDeIcones = { iconesDaLoja: async (loja) => { pedidos.push(['icones', loja]); return { c1: 'https://i' }; } };
  const accessRepository = { findAccountByClaims: async () => ({ hasEstablishment: true, establishmentId: 'loja-1', establishmentDocument: {}, permissions: { isAdmin: false, groupId: 'g', keys: [] } }) };
  const { requirePermission, accountForRequest } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'u1' }; next(); });
  app.use('/api/loja/app-do-cliente', createAppDoClienteDaLojaRoutes({ appDoClienteDaLoja, aparenciaDaHome, conjuntosDeIcones, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const resposta = await fetch(`http://127.0.0.1:${servidor.address().port}/api/loja/app-do-cliente/inicio`, { headers: { Authorization: 'Bearer t' } });
    assert.equal(resposta.status, 200);
    const { data } = await resposta.json();
    assert.deepEqual(data.app.aparenciaHome, { topo: 1, meio: 2, fim: 3, rodape: 2, preposicaoBusca: 'no' });
    assert.equal(data.app.featureFlags, undefined);
    assert.deepEqual(data.variacoes, { numeros: { topo: 3 } });
    assert.deepEqual(data.iconesDasCategorias, { c1: 'https://i' });
    assert.deepEqual(pedidos, [['app', 'loja-1'], ['icones', 'loja-1']]);
  } finally {
    await new Promise((resolve) => { servidor.close(resolve); });
  }
});

// Cola B57-10, item B1: o "Leva para" so oferece categoria que o app mostra e que abre com produto a venda.
function lojaComCategorias() {
  const documentos = {
    'estabelecimentos/loja-1': {},
    'estabelecimentos/loja-1/Banners/p1': banner('principal'),
    // c1: produto a venda (sem campo de estoque) numa subcategoria ativa.
    'estabelecimentos/loja-1/ProductCategories/c1': { name: 'Limpeza', isActive: true },
    'estabelecimentos/loja-1/ProductSubcategories/s1': { categoryId: 'c1', isActive: true },
    'estabelecimentos/loja-1/Products/a1': { isActive: true, isTrashed: false, currentPrice: 9.9, shelvesIds: ['c1_s1'] },
    // c2: so produto sem preco, sem estoque ou na lixeira.
    'estabelecimentos/loja-1/ProductCategories/c2': { name: 'Bebidas', isActive: true },
    'estabelecimentos/loja-1/ProductSubcategories/s2': { categoryId: 'c2', isActive: true },
    'estabelecimentos/loja-1/Products/b1': { isActive: true, isTrashed: false, currentPrice: 0, shelvesIds: ['c2_s2'] },
    'estabelecimentos/loja-1/Products/b2': { isActive: true, isTrashed: false, currentPrice: 5, quantityInStock: 0, shelvesIds: ['c2_s2'] },
    'estabelecimentos/loja-1/Products/b3': { isActive: true, isTrashed: true, currentPrice: 5, shelvesIds: ['c2_s2'] },
    // c3: produto a venda, mas a subcategoria esta desligada.
    'estabelecimentos/loja-1/ProductCategories/c3': { name: 'Padaria', isActive: true },
    'estabelecimentos/loja-1/ProductSubcategories/s3': { categoryId: 'c3', isActive: false },
    'estabelecimentos/loja-1/Products/c3p': { isActive: true, isTrashed: false, currentPrice: 5, shelvesIds: ['c3_s3'] },
    // c4: categoria desligada.
    'estabelecimentos/loja-1/ProductCategories/c4': { name: 'Frios', isActive: false },
    'estabelecimentos/loja-1/ProductSubcategories/s4': { categoryId: 'c4', isActive: true },
    'estabelecimentos/loja-1/Products/d1': { isActive: true, isTrashed: false, currentPrice: 5, shelvesIds: ['c4_s4'] },
    // c5: so produto desligado.
    'estabelecimentos/loja-1/ProductCategories/c5': { name: 'Hortifruti', isActive: true },
    'estabelecimentos/loja-1/ProductSubcategories/s5': { categoryId: 'c5', isActive: true },
    'estabelecimentos/loja-1/Products/e1': { isActive: false, isTrashed: false, currentPrice: 5, shelvesIds: ['c5_s5'] },
    // c6: produto a venda com estoque.
    'estabelecimentos/loja-1/ProductCategories/c6': { name: 'Mercearia', isActive: true },
    'estabelecimentos/loja-1/ProductSubcategories/s6': { categoryId: 'c6', isActive: true },
    'estabelecimentos/loja-1/Products/f1': { isActive: true, isTrashed: false, currentPrice: 3, quantityInStock: 4, shelvesIds: ['x_y', 'c6_s6'] },
    // c7: 35 subcategorias; o unico produto a venda esta na ultima (segunda consulta, de 30 em 30).
    'estabelecimentos/loja-1/ProductCategories/c7': { name: 'Pet', isActive: true },
    'estabelecimentos/loja-1/Products/g1': { isActive: true, isTrashed: false, currentPrice: 7, shelvesIds: ['c7_t34'] },
  };
  for (let indice = 0; indice < 35; indice += 1) documentos[`estabelecimentos/loja-1/ProductSubcategories/t${indice}`] = { categoryId: 'c7', isActive: true };
  return documentos;
}

test('B57-10, B1: os destinos com conteudo sao as categorias do app com produto a venda, de 30 em 30 prateleiras', async () => {
  const rota = await subir({ documentos: lojaComCategorias() });
  try {
    const { status, corpo } = await rota.chamar('/por-tipo/destinos');
    assert.equal(status, 200);
    assert.deepEqual(corpo.data, { categorias: ['c1', 'c6', 'c7'] });
    const deProdutos = rota.consultas.filter((consulta) => consulta.caminho === 'estabelecimentos/loja-1/Products');
    assert.ok(deProdutos.length >= 2, 'mais de 30 prateleiras: mais de uma consulta');
    deProdutos.forEach((consulta) => {
      const [[campo, operador, lote], ...resto] = consulta.filtros;
      assert.equal(campo, 'shelvesIds');
      assert.equal(operador, 'array-contains-any');
      assert.ok(lote.length >= 1 && lote.length <= 30);
      assert.deepEqual(resto, [['isActive', '==', true], ['isTrashed', '==', false]], 'a forma do indice de Products');
      assert.deepEqual(consulta.campos, ['isActive', 'isTrashed', 'currentPrice', 'quantityInStock', 'shelvesIds']);
    });
    assert.ok(deProdutos.every((consulta) => !consulta.filtros[0][2].some((prateleira) => prateleira.startsWith('c3_') || prateleira.startsWith('c4_'))), 'subcategoria ou categoria desligada nao e consultada');
    assert.deepEqual(rota.consultas.filter((consulta) => consulta.caminho !== 'estabelecimentos/loja-1/Products').map((consulta) => [consulta.caminho, consulta.filtros]), [
      ['estabelecimentos/loja-1/ProductCategories', [['isActive', '==', true]]],
      ['estabelecimentos/loja-1/ProductSubcategories', [['isActive', '==', true]]],
    ]);
  } finally {
    await rota.fechar();
  }
});

test('B57-10, B1: o "Leva para" recusa a categoria sem conteudo, com a recusa de categoria nao encontrada', async () => {
  const rota = await subir({ documentos: lojaComCategorias() });
  try {
    for (const id of ['c2', 'c3', 'c4', 'c5']) {
      const resposta = await rota.chamar('/por-tipo/p1', { method: 'PATCH', corpo: { levaPara: { tipo: 'categoria', id } } });
      assert.equal(resposta.status, 404, id);
      assert.equal(resposta.corpo.error.code, 'banner_categoria_nao_encontrada', id);
    }
    assert.equal(rota.rest.gravados.length, 0);
    const comConteudo = await rota.chamar('/por-tipo/p1', { method: 'PATCH', corpo: { levaPara: { tipo: 'categoria', id: 'c7' } } });
    assert.equal(comConteudo.status, 200);
    assert.equal(rota.rest.gravados.length, 1);
  } finally {
    await rota.fechar();
  }
});

test('B57-10, B1: produto a venda e ativo, fora da lixeira, com preco e com estoque (ou sem o campo)', () => {
  assert.equal(produtoAVenda({ isActive: true, currentPrice: 1 }), true);
  assert.equal(produtoAVenda({ isActive: true, currentPrice: 1, quantityInStock: null }), true);
  assert.equal(produtoAVenda({ isActive: true, currentPrice: 1, quantityInStock: 2 }), true);
  assert.equal(produtoAVenda({ isActive: true, currentPrice: 1, quantityInStock: 0 }), false);
  assert.equal(produtoAVenda({ isActive: true, currentPrice: 0 }), false);
  assert.equal(produtoAVenda({ isActive: false, currentPrice: 1 }), false);
  assert.equal(produtoAVenda({ isActive: true, isTrashed: true, currentPrice: 1 }), false);
});

// Cola B57-10, item B2: "Ofertas" como destino; o app do cliente le destino: 'ofertas' (com products
// vazio e category nula). Os outros destinos apagam o campo.
test('B57-10, B2: "Leva para" Ofertas grava destino ofertas, products vazio e category nula; os outros apagam o destino', async () => {
  const documentos = {
    'estabelecimentos/loja-1': {},
    'estabelecimentos/loja-1/Banners/p1': banner('principal', { products: [{ id: 'a' }] }),
    'estabelecimentos/loja-1/Banners/o1': banner('vertical', { destino: 'ofertas', products: [], category: null }),
    'estabelecimentos/loja-1/Products/pr1': { name: 'Picanha', currentPrice: 59.9 },
  };
  const rota = await subir({ documentos });
  try {
    const ofertas = await rota.chamar('/por-tipo/p1', { method: 'PATCH', corpo: { levaPara: { tipo: 'ofertas' } } });
    assert.equal(ofertas.status, 200);
    const gravado = rota.rest.gravados.at(-1);
    assert.deepEqual(gravado.opcoes.mascara, ['products', 'category', 'destino']);
    assert.deepEqual(gravado.documento.fields, { products: { arrayValue: {} }, category: { nullValue: null }, destino: { stringValue: 'ofertas' } });

    await rota.chamar('/por-tipo/p1', { method: 'PATCH', corpo: { levaPara: { tipo: 'produtos', ids: ['pr1'] } } });
    const produtos = rota.rest.gravados.at(-1);
    assert.deepEqual(produtos.opcoes.mascara, ['products', 'category', 'destino']);
    assert.equal(produtos.documento.fields.destino, undefined, 'na mascara e fora do corpo: o campo sai');

    const lista = await rota.chamar('/por-tipo');
    assert.deepEqual(lista.corpo.data.tipos.vertical.banners.find((item) => item.id === 'o1').levaPara, { tipo: 'ofertas' });
    assert.equal((await rota.chamar('/por-tipo/p1', { method: 'PATCH', corpo: { levaPara: { tipo: 'ofertas', id: 'x' } } })).status, 400, 'Ofertas sem outros campos');
  } finally {
    await rota.fechar();
  }
  assert.deepEqual(destinoDoBanner({ destino: 'ofertas', products: [], category: null }), { tipo: 'ofertas' });
  assert.deepEqual(destinoDoBanner({ destino: null, products: [] }), { tipo: 'nada' });
});

// Cola B57-10, item B3: na tela Loja, banner so liga com "Leva para"; o Admin continua como antes.
test('B57-10, B3: na tela Loja, o banner novo nasce desligado e o banner sem destino nao liga (409, banner_sem_destino)', async () => {
  const rota = await subir({
    documentos: {
      'estabelecimentos/loja-1': {},
      'estabelecimentos/loja-1/Banners/v1': banner('vertical', { status: false, started: false }),
      'estabelecimentos/loja-1/Banners/v2': banner('vertical', { status: false, started: false, destino: 'ofertas', products: [], category: null }),
      'estabelecimentos/loja-1/Banners/v3': banner('vertical', { status: false, started: false }),
    },
  });
  try {
    const criado = await rota.chamar(`/por-tipo?tipo=vertical&inicio=${encodeURIComponent('2026-11-19T15:00:00Z')}&fim=${encodeURIComponent(FIM.toISOString())}`, {
      method: 'POST', corpo: new Uint8Array([1, 2, 3]), tipo: 'image/png',
    });
    assert.equal(criado.status, 201);
    const campos = rota.rest.gravados[0].documento.fields;
    assert.equal(campos.status.booleanValue, false, 'abaixo do limite, mas sem destino: desligado');
    assert.equal(campos.started.booleanValue, false);
    assert.equal(campos.aguardandoInicio.booleanValue, false);
    const futuro = await rota.chamar(`/por-tipo?tipo=vertical&inicio=${encodeURIComponent('2026-11-21T15:00:00Z')}&fim=${encodeURIComponent(FIM.toISOString())}`, {
      method: 'POST', corpo: new Uint8Array([1, 2, 3]), tipo: 'image/png',
    });
    assert.equal(futuro.status, 201);
    assert.equal(rota.rest.gravados[1].documento.fields.aguardandoInicio.booleanValue, false, 'nem aguardando o inicio');

    const gravadosAntes = rota.rest.gravados.length;
    const semDestino = await rota.chamar('/por-tipo/v1', { method: 'PATCH', corpo: { ligado: true } });
    assert.equal(semDestino.status, 409);
    assert.equal(semDestino.corpo.error.code, 'banner_sem_destino');
    assert.equal(semDestino.corpo.error.message, 'Escolha para onde o banner leva.');
    assert.equal(rota.rest.gravados.length, gravadosAntes, 'nada gravado');

    const comDestino = await rota.chamar('/por-tipo/v2', { method: 'PATCH', corpo: { ligado: true } });
    assert.equal(comDestino.status, 200);
    assert.equal(rota.rest.gravados.at(-1).documento.fields.status.booleanValue, true);

    // Destino e "Ligado" juntos: o destino grava antes do ligar.
    const juntos = await rota.chamar('/por-tipo/v3', { method: 'PATCH', corpo: { ligado: true, levaPara: { tipo: 'ofertas' } } });
    assert.equal(juntos.status, 200);
    assert.deepEqual(rota.rest.gravados.slice(-2).map((gravado) => gravado.opcoes.mascara[0]), ['products', 'status']);
  } finally {
    await rota.fechar();
  }
});

test('B57-10, B3: o Admin (sem a opcao da tela Loja) continua criando ligado e ligando banner sem destino', async () => {
  const documentos = { 'estabelecimentos/loja-1': {}, 'estabelecimentos/loja-1/Banners/v1': banner('vertical', { status: false, started: false }) };
  const { firestore } = bancoEmMemoria(documentos);
  const rest = restEmMemoria(documentos);
  const admin = new BannersNoAdmin({
    firestore, bucket: { name: 'b', file: () => ({ save: async () => {}, delete: async () => {} }) }, restFirestore: rest,
    medir: async () => ({ largura: 400, altura: 700 }), agora: () => AGORA, novoId: () => 'novo1',
  });
  await admin.criar('loja-1', 'vertical', new Uint8Array([1]), 'image/png', { inicio: '2026-11-19T15:00:00Z', fim: FIM.toISOString() });
  assert.equal(rest.gravados[0].documento.fields.status.booleanValue, true);
  const { banner: ligado } = await admin.alterar('loja-1', 'v1', { ligado: true });
  assert.equal(rest.gravados.at(-1).documento.fields.status.booleanValue, true);
  assert.equal(ligado.id, 'v1');
});
