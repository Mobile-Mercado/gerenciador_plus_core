import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { AparenciaDaHome } from '../src/application/admin/AparenciaDaHome.js';
import { BannersNoAdmin, TIPOS_DE_BANNER } from '../src/application/admin/BannersNoAdmin.js';
import { AppDoClienteDaLoja } from '../src/application/loja/AppDoClienteDaLoja.js';
import { FAIXAS, VARIACOES, conferirAjustes } from '../src/domain/loja/variacoesDaHome.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola B56-08: variacoes da Inicio (B1-B4) e banners pelo Admin (B5).
const AGORA = new Date('2026-11-11T12:00:00Z');

function montar(extras = {}) {
  const banco = new FirestoreEmMemoria({
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    'estabelecimentos/loja-2': { name: 'Loja 2', aparenciaHome: { topo: 2 } },
    'estabelecimentos/loja-3': { name: 'Loja 3', aparenciaHome: { topo: 5, meio: 1 } },
    ...extras,
  });
  const comuns = { firestore: banco, serverTimestamp: () => AGORA };
  return { banco, home: new AparenciaDaHome(comuns), app: new AppDoClienteDaLoja(comuns) };
}

test('tabela B1: Topos 1-3 da Matriz, 4-6 do desenho antigo sem endereco; Meio e Fim com os valores da cola', () => {
  assert.deepEqual(VARIACOES.topo[2], { alturaBusca: 38, larguraBusca: 191, distanciaTopo: 62, tamanhoLogo: 100, alinhamentoLogo: 'base', endereco: 'card' });
  assert.equal(VARIACOES.topo[3].larguraBusca, 248.3);
  assert.equal(VARIACOES.topo[1].endereco, 'linha');
  assert.equal(VARIACOES.topo[1].larguraBusca, null, 'Topo 1 sem largura da busca');
  assert.deepEqual([4, 5, 6].map((n) => VARIACOES.topo[n].endereco), ['sem', 'sem', 'sem']);
  assert.equal(VARIACOES.topo[4].alinhamentoLogo, null);
  assert.deepEqual(VARIACOES.meio[1], {
    alturaBanner: 150, cantosBanner: 12, margemBanner: 16, tamanhoIcones: 63, espacoIcones: 22.5, espacoFileiras: 12,
    margemEsquerda: 35.5, espacoAcima: 26, espacoAbaixo: 27.2, nomeLigado: true, tamanhoNome: 11, fileiras: 2,
  });
  assert.deepEqual(VARIACOES.fim[4], { larguraCards: 136, espacoCards: 8, tamanhoTitulo: 21 });
  assert.deepEqual([1, 2, 3].map((n) => VARIACOES.fim[n].larguraCards), [132, 132, 132], "Fins 1 a 3 com 132 (B56-09)");
});

test('faixas B2: fora da faixa e recusado; chave que a variacao nao tem so aceita null', () => {
  assert.deepEqual(FAIXAS.topo.alturaBusca, [32, 48]);
  assert.deepEqual(conferirAjustes('topo', { alturaBusca: 40, larguraBusca: 200, endereco: 'linha' }, { numero: 2 }).problemas, []);
  assert.equal(conferirAjustes('topo', { alturaBusca: 31 }).problemas.length, 1);
  assert.equal(conferirAjustes('topo', { larguraBusca: 281 }).problemas.length, 1);
  assert.equal(conferirAjustes('topo', { alinhamentoLogo: 'meio' }).problemas.length, 1);
  assert.equal(conferirAjustes('topo', { larguraBusca: 200 }, { numero: 1 }).problemas.length, 1, 'Topo 1 sem largura');
  assert.equal(conferirAjustes('meio', { fileiras: 3 }).problemas.length, 1);
  assert.equal(conferirAjustes('meio', { tamanhoNome: 15, espacoAbaixo: 7 }).problemas.length, 2);
  assert.equal(conferirAjustes('fim', { larguraCards: 161 }).problemas.length, 1);
  assert.equal(conferirAjustes('fim', { cor: 'x' }).problemas.length, 1, 'ajuste desconhecido');
});

test('publicar da loja (B4.g): variacao, modelo e ajustes; fora da faixa recusa; trocar a variacao volta aos ajustes dela', async () => {
  const { banco, home, app } = montar();
  await app.salvar('loja-1', { aparenciaHome: { topo: 5, topoAjustes: { alturaBusca: 44 } } });
  let loja = banco.dados('estabelecimentos/loja-1').aparenciaHome;
  assert.equal(loja.topo, 5);
  assert.equal(loja.topoModelo, null);
  assert.deepEqual(loja.topoAjustes, { ...VARIACOES.topo[5], alturaBusca: 44 });
  await assert.rejects(app.salvar('loja-1', { aparenciaHome: { topoAjustes: { alturaBusca: 60 } } }), (erro) => erro.code === 'ajuste_fora_da_faixa');
  await app.salvar('loja-1', { aparenciaHome: { topo: 3 } });
  assert.deepEqual(banco.dados('estabelecimentos/loja-1').aparenciaHome.topoAjustes, VARIACOES.topo[3]);
  const modelo = await home.criarModelo({ nome: 'Topo grande', bloco: 'topo', base: 2, ajustes: { alturaBusca: 46, endereco: 'linha' } }, { uid: 'admin-1' });
  const salvo = await app.salvar('loja-1', { aparenciaHome: { topoModelo: modelo.id } });
  loja = banco.dados('estabelecimentos/loja-1').aparenciaHome;
  assert.equal(loja.topo, 2, 'o modelo fixa a variacao na base dele');
  assert.equal(loja.topoModelo, modelo.id);
  assert.equal(loja.topoAjustes.alturaBusca, 46);
  assert.equal(salvo.app.ajustesDaHome.topoModelo, modelo.id);
  await assert.rejects(app.salvar('loja-1', { aparenciaHome: { meioModelo: modelo.id } }), (erro) => erro.code === 'modelo_nao_encontrado', 'modelo de outro bloco');
  await app.salvar('loja-1', { aparenciaHome: { topo: 4 } });
  assert.equal(banco.dados('estabelecimentos/loja-1').aparenciaHome.topoModelo, null, 'trocar a variacao tira o modelo');
});

test('modelos (B4.a-c): criar com os ajustes completos, listar com as lojas, salvar regrava so as lojas do modelo', async () => {
  const { banco, home, app } = montar();
  const modelo = await home.criarModelo({ nome: 'Meio compacto', bloco: 'meio', base: 1, ajustes: { alturaBanner: 120, fileiras: 1 } }, { uid: 'admin-1' });
  assert.deepEqual(modelo.ajustes, { ...VARIACOES.meio[1], alturaBanner: 120, fileiras: 1 });
  await assert.rejects(home.criarModelo({ nome: 'meio COMPACTO', bloco: 'meio', base: 1 }), (erro) => erro.code === 'modelo_nome_repetido');
  await assert.rejects(home.criarModelo({ nome: 'Meio 2', bloco: 'meio', base: 1 }), (erro) => erro.code === 'modelo_nome_repetido', 'nome de variacao do app');
  await assert.rejects(home.criarModelo({ nome: 'X', bloco: 'meio', base: 4 }), (erro) => erro.code === 'variacao_invalida');
  await assert.rejects(home.criarModelo({ nome: 'X', bloco: 'meio', base: 1, ajustes: { alturaBanner: 300 } }), (erro) => erro.code === 'ajuste_fora_da_faixa');
  await app.salvar('loja-1', { aparenciaHome: { meioModelo: modelo.id } });
  await app.salvar('loja-2', { aparenciaHome: { meioModelo: modelo.id } });
  assert.deepEqual((await home.listarModelos('meio')).map((item) => [item.nome, item.lojas]), [['Meio compacto', 2]]);
  assert.deepEqual(await home.afetadas({ modeloId: modelo.id }), { lojas: 2 });
  const resultado = await home.salvarModelo(modelo.id, { ajustes: { alturaBanner: 180 } }, { uid: 'admin-2' });
  assert.equal(resultado.lojasAlteradas, 2);
  assert.deepEqual(resultado.lojas.sort(), ['loja-1', 'loja-2']);
  assert.equal(banco.dados('estabelecimentos/loja-1').aparenciaHome.meioAjustes.alturaBanner, 180);
  assert.equal(banco.dados('estabelecimentos/loja-2').aparenciaHome.meioAjustes.fileiras, 1, 'o resto do modelo continua');
  assert.equal(banco.dados('estabelecimentos/loja-3').aparenciaHome.meioAjustes, undefined, 'loja sem o modelo nao muda');
});

test('padrao para todas as lojas (B4.d) e voltar ao original (B4.e): so quem usa a variacao sem modelo, inclusive quem nao gravou nada', async () => {
  const { banco, home, app } = montar();
  const modelo = await home.criarModelo({ nome: 'Topo X', bloco: 'topo', base: 2 });
  await app.salvar('loja-2', { aparenciaHome: { topoModelo: modelo.id } });
  // loja-1 sem aparenciaHome (usa o Topo 2 padrao), loja-2 no modelo, loja-3 no Topo 5.
  assert.deepEqual(await home.afetadas({ bloco: 'topo', numero: 2 }), { lojas: 1, comAjusteProprio: 0 });
  const mudado = await home.mudarPadrao('topo', 2, { alturaBusca: 42 }, { uid: 'admin-1' });
  assert.equal(mudado.lojasAlteradas, 1);
  assert.deepEqual(mudado.lojas, ['loja-1']);
  assert.equal(banco.dados('estabelecimentos/loja-1').aparenciaHome.topoAjustes.alturaBusca, 42);
  assert.equal(banco.dados('estabelecimentos/loja-2').aparenciaHome.topoAjustes.alturaBusca, 38, 'loja no modelo nao muda');
  assert.equal(banco.dados('aparenciaPadrao/padroes').topo['2'].alturaBusca, 42);
  const variacoes = await home.variacoes();
  assert.equal(variacoes.variacoes.topo[2].padraoMudado, true);
  assert.equal(variacoes.variacoes.topo[2].ajustes.alturaBusca, 42);
  assert.equal(variacoes.variacoes.topo[2].original.alturaBusca, 38);
  // Loja nova no Topo 2 passa a receber o padrao mudado.
  await app.salvar('loja-3', { aparenciaHome: { topo: 2 } });
  assert.equal(banco.dados('estabelecimentos/loja-3').aparenciaHome.topoAjustes.alturaBusca, 42);
  const original = await home.voltarAoOriginal('topo', 2, { uid: 'admin-1' });
  assert.equal(original.lojasAlteradas, 2);
  assert.equal(banco.dados('estabelecimentos/loja-1').aparenciaHome.topoAjustes.alturaBusca, 38);
  assert.equal(banco.dados('aparenciaPadrao/padroes').topo['2'], undefined);
  await assert.rejects(home.voltarAoOriginal('topo', 2), (erro) => erro.code === 'padrao_ja_original');
  await assert.rejects(home.mudarPadrao('topo', 2, { distanciaTopo: 90 }), (erro) => erro.code === 'ajuste_fora_da_faixa');
});

// ----- Cola B56-21 (Passo 0): padrao e voltar ao original so nas lojas da versao sem ajuste
// proprio; as com ajuste proprio so com a caixa marcada (incluirAjusteProprio). -----

// loja-a e loja-b na versao 2 do topo (loja-a sem nada gravado, loja-b com os ajustes da tabela);
// loja-c no Topo 3; loja-d no Topo 2 com ajuste proprio (alturaBusca 44, fora da tabela).
function montarAjusteProprio() {
  const tabela = { ...VARIACOES.topo[2] };
  return montar({
    'estabelecimentos/loja-a': { name: 'A' },
    'estabelecimentos/loja-b': { name: 'B', aparenciaHome: { topo: 2, topoModelo: null, topoAjustes: tabela } },
    'estabelecimentos/loja-c': { name: 'C', aparenciaHome: { topo: 3, topoAjustes: { ...VARIACOES.topo[3] } } },
    'estabelecimentos/loja-d': { name: 'D', aparenciaHome: { topo: 2, topoAjustes: { ...tabela, alturaBusca: 44 } } },
  });
}

function semLojasAntigas(banco) {
  ['loja-1', 'loja-2', 'loja-3'].forEach((id) => banco.docs.delete(`estabelecimentos/${id}`));
  return banco;
}

const alturaDe = (banco, id) => banco.dados(`estabelecimentos/${id}`).aparenciaHome?.topoAjustes?.alturaBusca;

for (const acao of ['mudarPadrao', 'voltarAoOriginal']) {
  // voltarAoOriginal precisa de um padrao mudado antes: muda o topo 2 para 40 com a caixa marcada
  // (todas as da versao ficam com 40) e grava o ajuste proprio da loja-d de novo (44).
  async function preparar() {
    const { banco, home } = montarAjusteProprio();
    semLojasAntigas(banco);
    if (acao === 'voltarAoOriginal') {
      await home.mudarPadrao('topo', 2, { alturaBusca: 40 }, {}, { incluirAjusteProprio: true });
      const d = banco.dados('estabelecimentos/loja-d');
      banco.docs.set('estabelecimentos/loja-d', { ...d, aparenciaHome: { ...d.aparenciaHome, topoAjustes: { ...d.aparenciaHome.topoAjustes, alturaBusca: 44 } } });
    }
    const executar = (opcoes) => (acao === 'mudarPadrao'
      ? home.mudarPadrao('topo', 2, { alturaBusca: 42 }, {}, opcoes)
      : home.voltarAoOriginal('topo', 2, {}, opcoes));
    const esperado = acao === 'mudarPadrao' ? 42 : VARIACOES.topo[2].alturaBusca;
    return { banco, home, executar, esperado };
  }

  test(`${acao} (B56-21): mesma versao sem ajuste muda; afetadas conta N e M`, async () => {
    const { banco, home, executar, esperado } = await preparar();
    assert.deepEqual(await home.afetadas({ bloco: 'topo', numero: 2 }), { lojas: 2, comAjusteProprio: 1 });
    const resultado = await executar();
    assert.equal(alturaDe(banco, 'loja-a'), esperado, 'loja sem nada gravado, na versao 2');
    assert.equal(alturaDe(banco, 'loja-b'), esperado, 'loja com os ajustes da versao');
    assert.equal(resultado.lojasAlteradas, 2);
    assert.equal(resultado.lojasComAjusteProprio, 1);
  });

  test(`${acao} (B56-21): outra versao fica`, async () => {
    const { banco, executar } = await preparar();
    await executar({ incluirAjusteProprio: true });
    assert.equal(alturaDe(banco, 'loja-c'), VARIACOES.topo[3].alturaBusca);
  });

  test(`${acao} (B56-21): com ajuste proprio e caixa desmarcada, fica`, async () => {
    const { banco, executar } = await preparar();
    const resultado = await executar({ incluirAjusteProprio: false });
    assert.equal(alturaDe(banco, 'loja-d'), 44);
    assert.deepEqual(resultado.lojas.sort(), ['loja-a', 'loja-b']);
  });

  test(`${acao} (B56-21): com ajuste proprio e caixa marcada, muda`, async () => {
    const { banco, executar, esperado } = await preparar();
    const resultado = await executar({ incluirAjusteProprio: true });
    assert.equal(alturaDe(banco, 'loja-d'), esperado);
    assert.equal(resultado.lojasAlteradas, 3);
  });
}

test('voltar ao original (B56-21) mantem os padroes mudados dos outros blocos e das outras versoes', async () => {
  const { banco, home } = montar();
  await home.mudarPadrao('topo', 2, { alturaBusca: 42 });
  await home.mudarPadrao('topo', 3, { alturaBusca: 40 });
  await home.mudarPadrao('meio', 2, { fileiras: 1 });
  await home.voltarAoOriginal('topo', 2);
  const padroes = banco.dados('aparenciaPadrao/padroes');
  assert.equal(padroes.topo['2'], undefined, 'o topo 2 volta ao original');
  assert.equal(padroes.topo['3'].alturaBusca, 40, 'o topo 3 continua mudado');
  assert.equal(padroes.meio['2'].fileiras, 1, 'o meio 2 continua mudado');
});

test('regravacao em lotes: mais de 400 lojas no mesmo padrao', async () => {
  const lojas = Object.fromEntries(Array.from({ length: 450 }, (_, indice) => [`estabelecimentos/l${indice}`, { name: `L${indice}` }]));
  const banco = new FirestoreEmMemoria(lojas);
  const home = new AparenciaDaHome({ firestore: banco, serverTimestamp: () => AGORA });
  let lotes = 0;
  const original = banco.batch.bind(banco);
  banco.batch = () => { lotes += 1; return original(); };
  const resultado = await home.mudarPadrao('fim', 2, { larguraCards: 140 });
  assert.equal(resultado.lojasAlteradas, 450);
  assert.equal(lotes, 2);
  assert.equal(banco.dados('estabelecimentos/l449').aparenciaHome.fimAjustes.larguraCards, 140);
});

// ----- Banners (B5) -----
function restNoBanco(banco) {
  const valor = (campo) => {
    if ('nullValue' in campo) return null;
    if ('booleanValue' in campo) return campo.booleanValue;
    if ('stringValue' in campo) return campo.stringValue;
    if ('doubleValue' in campo) return campo.doubleValue;
    if ('timestampValue' in campo) return new Date(campo.timestampValue);
    if ('arrayValue' in campo) return (campo.arrayValue.values || []).map(valor);
    if ('mapValue' in campo) return Object.fromEntries(Object.entries(campo.mapValue.fields || {}).map(([chave, item]) => [chave, valor(item)]));
    throw new Error('campo sem conversao');
  };
  return {
    gravacoes: [],
    async gravar(caminho, documento, opcoes) {
      this.gravacoes.push({ caminho, opcoes });
      const dados = Object.fromEntries(Object.entries(documento.fields).map(([chave, campo]) => [chave, valor(campo)]));
      if (opcoes.criar && banco.dados(caminho)) throw new Error('ja existe');
      await banco.doc(caminho).set(dados, { merge: !opcoes.criar });
    },
  };
}

function montarBanners(extras = {}) {
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Loja 1', coverImageUrl: 'https://capa' }, ...extras });
  const salvos = [];
  const bucket = { name: 'b', file: (caminho) => ({ save: async (conteudo, opcoes) => { salvos.push({ caminho, contentType: opcoes.contentType }); }, delete: async () => {} }) };
  let id = 0;
  let relogio = AGORA.getTime();
  const banners = new BannersNoAdmin({ firestore: banco, bucket, restFirestore: restNoBanco(banco), agora: () => relogio, novoId: () => `b${++id}` });
  return { banco, banners, salvos, avancar: (ms) => { relogio += ms; } };
}

const imagem = (largura, altura, formato = 'jpeg') => sharp({ create: { width: largura, height: altura, channels: 3, background: '#2E4BD6' } })[formato]().toBuffer();
const periodo = { inicio: '2026-11-10T00:00:00Z', fim: '2026-12-10T00:00:00Z' };

test('banners: medidas e peso do Mobile Gerenciador (principal e posVertical 1080x500, vertical 400x700, popup livre, ate 1 MB)', async () => {
  const { banners, banco, salvos } = montarBanners();
  const principal = await banners.criar('loja-1', 'principal', await imagem(1080, 500), 'image/jpeg', periodo);
  assert.equal(principal.tipo, 'principal');
  const gravado = banco.dados('estabelecimentos/loja-1/Banners/b1');
  assert.deepEqual(Object.keys(gravado).sort(), ['category', 'endAt', 'id', 'image', 'products', 'showTimer', 'startAt', 'started', 'status', 'type'].sort());
  assert.deepEqual(gravado.image.size, { width: 1080, height: 500 });
  assert.equal(gravado.showTimer, false);
  assert.match(salvos[0].caminho, /^estabelecimentos\/loja-1\/banners\/\d+\.jpg$/);
  await assert.rejects(banners.criar('loja-1', 'principal', await imagem(1000, 500), 'image/jpeg', periodo), (erro) => erro.code === 'banner_tamanho_errado' && /1080 x 500/.test(erro.message));
  await assert.rejects(banners.criar('loja-1', 'vertical', await imagem(1080, 500), 'image/jpeg', periodo), (erro) => erro.code === 'banner_tamanho_errado' && /400 x 700/.test(erro.message));
  await banners.criar('loja-1', 'vertical', await imagem(400, 700, 'png'), 'image/png', periodo);
  await banners.criar('loja-1', 'popup', await imagem(600, 900, 'webp'), 'image/webp', periodo);
  const pesado = Buffer.alloc(1024 * 1024 + 1, 1);
  await assert.rejects(banners.criar('loja-1', 'posVertical', pesado, 'image/jpeg', periodo), (erro) => erro.code === 'banner_peso' && /O limite é 1 MB/.test(erro.message));
  await assert.rejects(banners.criar('loja-1', 'vertical', await imagem(400, 700), 'image/gif', periodo), (erro) => erro.code === 'banner_formato');
});

test('banners: limite por tipo (principal 5, popup 1); desligado e encerrado liberam a vaga', async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(TIPOS_DE_BANNER).map(([tipo, regra]) => [tipo, regra.limite])), { principal: 5, vertical: 10, posVertical: 5, popup: 1 });
  const { banners } = montarBanners();
  const foto = await imagem(1080, 500);
  for (let i = 0; i < 5; i += 1) await banners.criar('loja-1', 'principal', foto, 'image/jpeg', periodo);
  await assert.rejects(banners.criar('loja-1', 'principal', foto, 'image/jpeg', periodo), (erro) => erro.code === 'banner_limite' && erro.statusCode === 409);
  await banners.alterar('loja-1', 'b1', { ligado: false });
  await banners.criar('loja-1', 'principal', foto, 'image/jpeg', periodo);
  await assert.rejects(banners.alterar('loja-1', 'b1', { ligado: true }), (erro) => erro.code === 'banner_limite', 'religar sem vaga');
  const popup = await imagem(500, 500);
  await banners.criar('loja-1', 'popup', popup, 'image/jpeg', periodo);
  await assert.rejects(banners.criar('loja-1', 'popup', popup, 'image/jpeg', periodo), (erro) => erro.code === 'banner_limite');
  const lista = await banners.listar('loja-1');
  assert.equal(lista.tipos.principal.ocupados, 5);
  assert.equal(lista.tipos.principal.banners.length, 6, 'o desligado continua na lista');
  assert.equal(lista.tipos.popup.ocupados, 1);
  assert.equal(lista.capaUrl, 'https://capa', 'o banner capa continua sendo o coverImageUrl');
});

test('banners: contador so em principal e posVertical; datas, ligar com inicio no futuro aguarda; apagar', async () => {
  const { banners, banco } = montarBanners();
  await banners.criar('loja-1', 'principal', await imagem(1080, 500), 'image/jpeg', periodo);
  await banners.criar('loja-1', 'vertical', await imagem(400, 700), 'image/jpeg', periodo);
  const comContador = await banners.alterar('loja-1', 'b1', { contador: true });
  assert.equal(comContador.banner.contador, true);
  assert.equal(banco.dados('estabelecimentos/loja-1/Banners/b1').showTimer, true);
  await assert.rejects(banners.alterar('loja-1', 'b2', { contador: true }), (erro) => erro.code === 'banner_sem_contador');
  const futuro = await banners.alterar('loja-1', 'b1', { inicio: '2026-11-20T00:00:00Z', fim: '2026-12-20T00:00:00Z' });
  assert.equal(futuro.banner.inicio, '2026-11-20T00:00:00.000Z');
  assert.equal(banco.dados('estabelecimentos/loja-1/Banners/b1').aguardandoInicio, true);
  assert.equal(futuro.banner.situacao, 'agendado');
  await assert.rejects(banners.alterar('loja-1', 'b1', { fim: '2026-11-01T00:00:00Z' }), (erro) => erro.code === 'banner_periodo_invalido');
  const desligado = await banners.alterar('loja-1', 'b1', { ligado: false });
  assert.equal(desligado.banner.ligado, false);
  await banners.apagar('loja-1', 'b2');
  assert.equal(banco.dados('estabelecimentos/loja-1/Banners/b2'), undefined);
  await assert.rejects(banners.apagar('loja-1', 'b2'), (erro) => erro.code === 'banner_nao_encontrado');
});

// ----- Rotas -----
test('rotas do Admin: variacoes, afetadas, modelos, padrao e banners, com auditoria nas lojas regravadas', async () => {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { createAdminAuditMiddleware } = await import('../src/http/middlewares/adminAudit.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { banco, home, app: appDoCliente } = montar();
  const { banners } = montarBanners();
  const appExpress = express();
  appExpress.use(express.json());
  appExpress.use((request, _response, next) => { request.auth = { uid: 'admin-1' }; next(); });
  appExpress.use('/api/admin', createAdminAuditMiddleware({ firestore: banco, serverTimestamp: () => AGORA }),
    createAdminRoutes({ aparenciaDaHome: home, bannersNoAdmin: banners, appDoClienteDaLoja: appDoCliente }));
  appExpress.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = appExpress.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin`;
  const chamar = (metodo, caminho, corpo) => fetch(`${base}${caminho}`, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  try {
    const variacoes = (await (await chamar('GET', '/aparencia-home/variacoes')).json()).data;
    assert.equal(variacoes.numeros.topo, 6);
    assert.equal(variacoes.variacoes.topo['5'].ajustes.larguraBusca, 199.6);
    assert.equal((await (await chamar('GET', '/aparencia-home/afetadas?bloco=topo&numero=2')).json()).data.lojas, 2, 'loja-1 sem nada e loja-2 no Topo 2');
    assert.equal((await chamar('GET', '/aparencia-home/afetadas?bloco=topo')).status, 400);
    const criado = await chamar('POST', '/modelos-aparencia', { nome: 'Fim largo', bloco: 'fim', base: 2, ajustes: { larguraCards: 150 } });
    assert.equal(criado.status, 201);
    assert.equal((await chamar('POST', '/modelos-aparencia', { nome: 'Fim estreito', bloco: 'fim', base: 2, ajustes: { larguraCards: 90 } })).status, 400);
    // Cola B56-21: loja-4 no Topo 2 com ajuste proprio (tamanhoLogo 140) conta em M e so muda com a caixa.
    banco.docs.set('estabelecimentos/loja-4', { name: 'Loja 4', aparenciaHome: { topo: 2, topoAjustes: { ...VARIACOES.topo[2], tamanhoLogo: 140 } } });
    assert.deepEqual((await (await chamar('GET', '/aparencia-home/afetadas?bloco=topo&numero=2')).json()).data, { lojas: 2, comAjusteProprio: 1 });
    const padrao = await chamar('PUT', '/aparencia-padrao/topo/2', { ajustes: { tamanhoLogo: 120 } });
    assert.deepEqual((await padrao.json()).data.lojasAlteradas, 2);
    assert.equal(banco.dados('estabelecimentos/loja-4').aparenciaHome.topoAjustes.tamanhoLogo, 140, 'caixa desmarcada: a loja com ajuste proprio fica');
    assert.equal((await chamar('PUT', '/aparencia-padrao/topo/2', { ajustes: {}, incluirAjusteProprio: 'sim' })).status, 400);
    const original = await chamar('DELETE', '/aparencia-padrao/topo/2?incluirAjusteProprio=true');
    assert.equal(original.status, 200);
    assert.equal((await original.json()).data.lojasAlteradas, 3, 'caixa marcada: entram as 2 e a loja-4');
    assert.equal(banco.dados('estabelecimentos/loja-4').aparenciaHome.topoAjustes.tamanhoLogo, VARIACOES.topo[2].tamanhoLogo);
    assert.equal((await chamar('DELETE', '/aparencia-padrao/topo/2')).status, 409);
    assert.equal((await chamar('PATCH', '/estabelecimentos/loja-1/app-do-cliente', { aparenciaHome: { meio: 3, meioAjustes: { tamanhoIcones: 50 } } })).status, 200);
    assert.equal((await chamar('PATCH', '/estabelecimentos/loja-1/app-do-cliente', { aparenciaHome: { meioAjustes: { tamanhoIcones: 90 } } })).status, 400);
    const lista = await chamar('GET', '/estabelecimentos/loja-1/banners');
    assert.equal(lista.status, 200);
    const foto = await imagem(1080, 500);
    const enviado = await fetch(`${base}/estabelecimentos/loja-1/banners?tipo=principal&inicio=${periodo.inicio}&fim=${periodo.fim}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: foto });
    assert.equal(enviado.status, 201);
    const { id } = (await enviado.json()).data;
    assert.equal((await chamar('PATCH', `/estabelecimentos/loja-1/banners/${id}`, { contador: true })).status, 200);
    assert.equal((await chamar('DELETE', `/estabelecimentos/loja-1/banners/${id}`)).status, 200);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    const naLoja2 = [...banco.docs.entries()].filter(([caminho]) => caminho.startsWith('estabelecimentos/loja-2/AdminAuditLogs/')).map(([, dados]) => dados.details.acao);
    assert.ok(naLoja2.includes('padrao_aparencia_mudado') && naLoja2.includes('padrao_aparencia_original'), 'auditoria nas lojas regravadas');
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});
