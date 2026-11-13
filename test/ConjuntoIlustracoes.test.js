import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ESCOLHA_QUANDO_DIFEREM, EXTRAS_DE_OUTRAS_LOJAS, alvoPermitido, caminhoNoStorage, escolherArquivos, escritaPermitida, montarLista,
} from '../scripts/montarConjuntoIlustracoes.mjs';

// Cola B56-04, item 2.5: lista do conjunto "Ilustracoes" a partir dos icones da Zero Grau e da G&S.
const ZG = 'jQQjHTCc2zW1tuZMQzGF';
const GS = 'GkFYWdOBKD1vbzYoem9K';
const url = (caminho) => `https://firebasestorage.googleapis.com/v0/b/b/o/${encodeURIComponent(caminho)}?alt=media&token=segredo`;

test('ilustracoes: casa pelo id da lista padrao; as duas lojas com icone ficam as duas, sem escolher; o resto vai para o lado', () => {
  const lista = montarLista({
    categoriasPorLoja: {
      [ZG]: [
        { id: 'bebidas', nome: 'Bebidas', icon: url(`estabelecimentos/${ZG}/category_icons/bebidas.webp`) },
        { id: 'escolar', nome: 'Escolar', icon: url(`estabelecimentos/${ZG}/category_icons/escolar.webp`) },
        { id: 'tabacaria', nome: 'Tabacaria', icon: url('categoriasProdutos/tabacaria.svg') },
        { id: 'auto123', nome: 'Promos', icon: url(`estabelecimentos/${ZG}/category_icons/promo.webp`) },
      ],
      [GS]: [
        { id: 'bebidas', nome: 'Bebidas', icon: url(`estabelecimentos/${GS}/category_icons/bebidas.webp`) },
        { id: 'acougue', nome: 'Açougue', icon: url(`estabelecimentos/${GS}/category_icons/acougue.webp`) },
        { id: 'vazia', nome: 'Vazia', icon: '' },
      ],
    },
    catalogo: { bebidas: { nome: 'Bebidas' }, escolar: { nome: 'Escolar' }, acougue: { nome: 'Açougue' }, tabacaria: { nome: 'Tabacaria' }, auto123: null, vazia: { nome: 'Vazia' } },
  });
  assert.deepEqual(lista.entraria.map((linha) => [linha.categoriaId, linha.escolha, linha.candidatos.map((c) => c.loja)]), [
    ['acougue', 'G&S', ['G&S']],
    ['bebidas', 'em aberto (as duas lojas têm ícone)', ['Zero Grau', 'G&S']],
    ['escolar', 'Zero Grau', ['Zero Grau']],
  ]);
  assert.equal(lista.entraria[1].candidatos[0].icone, `estabelecimentos/${ZG}/category_icons/bebidas.webp`, 'so o caminho, sem token');
  assert.deepEqual(lista.resumo, { categoriasNoConjunto: 3, comDuasOpcoes: 1, foraDaListaPadrao: 1, jaDaListaPadrao: 1, semIcone: 1 });
  assert.equal(lista.foraDaListaPadrao[0].categoriaId, 'auto123');
  assert.equal(JSON.stringify(lista).includes('segredo'), false, 'nenhum token na saida');
});

test('ilustracoes: so roda contra o emulador local com projeto demo-*', () => {
  assert.equal(alvoPermitido({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, 'demo-rp44'), true);
  assert.equal(alvoPermitido({ FIRESTORE_EMULATOR_HOST: 'localhost:8080' }, 'demo-x'), true);
  assert.equal(alvoPermitido({}, 'demo-rp44'), false, 'sem emulador, recusa');
  assert.equal(alvoPermitido({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, 'appmobileprod-19505'), false, 'projeto de producao, recusa');
  assert.equal(alvoPermitido({ FIRESTORE_EMULATOR_HOST: '10.0.0.5:8080' }, 'demo-rp44'), false);
  assert.equal(caminhoNoStorage('gs://b/pasta/a.svg'), 'pasta/a.svg');
});

// Cola B56-14, parte 2: o script cria o conjunto, um arquivo por categoria padrao.
const linha = (categoriaId, ...candidatos) => ({ categoriaId, nomePadrao: categoriaId, candidatos: candidatos.map(([loja, icone]) => ({ loja, icone })) });

test('ilustracoes (B56-14): arquivos iguais nas duas, o comum; Frios e Lacteos diferentes, o da G&S; uma loja so, o dela', () => {
  const arquivos = {
    [`estabelecimentos/${ZG}/category_icons/bebidas.webp`]: Buffer.from('igual'),
    [`estabelecimentos/${GS}/category_icons/bebidas.webp`]: Buffer.from('igual'),
    [`estabelecimentos/${ZG}/category_icons/frios.webp`]: Buffer.from('zero'),
    [`estabelecimentos/${GS}/category_icons/frios2.webp`]: Buffer.from('gs'),
    [`estabelecimentos/${ZG}/category_icons/escolar.webp`]: Buffer.from('escolar'),
  };
  const { escolhidos, problemas } = escolherArquivos([
    linha('bebidas', ['Zero Grau', `estabelecimentos/${ZG}/category_icons/bebidas.webp`], ['G&S', `estabelecimentos/${GS}/category_icons/bebidas.webp`]),
    linha('frios_e_laticinios', ['Zero Grau', `estabelecimentos/${ZG}/category_icons/frios.webp`], ['G&S', `estabelecimentos/${GS}/category_icons/frios2.webp`]),
    linha('escolar', ['Zero Grau', `estabelecimentos/${ZG}/category_icons/escolar.webp`]),
  ], (caminho) => arquivos[caminho] || null);
  assert.deepEqual(problemas, []);
  assert.deepEqual(escolhidos.map((item) => [item.categoriaId, item.origem, item.icone.split('/').pop(), item.tipoArquivo]), [
    ['bebidas', 'as duas (arquivo igual)', 'bebidas.webp', 'image/webp'],
    ['frios_e_laticinios', 'G&S (arquivos diferentes)', 'frios2.webp', 'image/webp'],
    ['escolar', 'Zero Grau', 'escolar.webp', 'image/webp'],
  ]);
  assert.deepEqual(ESCOLHA_QUANDO_DIFEREM, { frios_e_laticinios: 'G&S' });
});

test('ilustracoes (B56-14): arquivos diferentes sem escolha, arquivo faltando ou acima de 20 KB param tudo antes de gravar', () => {
  const grande = Buffer.alloc(20 * 1024 + 1);
  const { escolhidos, problemas } = escolherArquivos([
    linha('cereais', ['Zero Grau', 'a/cereais.webp'], ['G&S', 'b/cereais.webp']),
    linha('pet', ['G&S', 'b/pet.webp']),
    linha('massas', ['G&S', 'b/massas.webp']),
    linha('limpeza', ['G&S', 'b/limpeza.gif']),
  ], (caminho) => ({ 'a/cereais.webp': Buffer.from('1'), 'b/cereais.webp': Buffer.from('2'), 'b/massas.webp': grande, 'b/limpeza.gif': Buffer.from('x') })[caminho] || null);
  assert.equal(escolhidos.length, 0);
  assert.equal(problemas.length, 4);
  assert.match(problemas[0], /^cereais: as duas lojas têm arquivos diferentes/);
  assert.match(problemas[1], /^pet: arquivo não encontrado/);
  assert.match(problemas[2], /^massas: 20481 bytes, acima de 20 KB/);
  assert.match(problemas[3], /^limpeza: tipo .gif/);
});

test('ilustracoes (B56-14, 2.0): criar so com os dois emuladores locais e o projeto demo-rp44', () => {
  const env = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' };
  assert.equal(escritaPermitida(env, 'demo-rp44'), true);
  assert.equal(escritaPermitida({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, 'demo-rp44'), false, 'sem o emulador do Storage');
  assert.equal(escritaPermitida({ FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' }, 'demo-rp44'), false, 'sem o emulador do Firestore');
  assert.equal(escritaPermitida(env, 'demo-outro'), false, 'outro projeto demo');
  assert.equal(escritaPermitida(env, 'appmobileprod-19505'), false, 'producao');
  assert.equal(escritaPermitida({ ...env, FIREBASE_STORAGE_EMULATOR_HOST: 'storage.googleapis.com:443' }, 'demo-rp44'), false);
});

test('ilustracoes (B56-16, 2.1): de fora das duas lojas, so o vinhos.webp da UAU Mart, para Vinhos', () => {
  const UAU = 'q0IPIusmpEq3pHbMyfWY';
  const VINHOS = 'q3lNcbPYgqxGcJuf39EV';
  assert.equal(EXTRAS_DE_OUTRAS_LOJAS.length, 1, 'um arquivo so da UAU Mart');
  assert.deepEqual({ ...EXTRAS_DE_OUTRAS_LOJAS[0] }, {
    loja: 'UAU Mart', lojaId: UAU, categoriaId: VINHOS, icone: `estabelecimentos/${UAU}/category_icons/vinhos.webp`,
  });

  const categoriasPorLoja = { [ZG]: [{ id: 'bebidas', nome: 'Bebidas', icon: url(`estabelecimentos/${ZG}/category_icons/bebidas.webp`) }], [GS]: [] };
  const lista = montarLista({ categoriasPorLoja, catalogo: { bebidas: { nome: 'Bebidas' }, [VINHOS]: { nome: 'Vinhos' } }, extras: EXTRAS_DE_OUTRAS_LOJAS });
  assert.deepEqual(lista.entraria.map((linha) => [linha.categoriaId, linha.escolha]), [['bebidas', 'Zero Grau'], [VINHOS, 'UAU Mart']]);

  const arquivo = Buffer.from('RIFF....WEBPvinhos');
  const { escolhidos, problemas } = escolherArquivos(lista.entraria, (caminho) => (caminho.includes(UAU) || caminho.includes(ZG) ? arquivo : null));
  assert.deepEqual(problemas, []);
  assert.deepEqual(escolhidos.map((item) => [item.categoriaId, item.origem, item.tipoArquivo]), [['bebidas', 'Zero Grau', 'image/webp'], [VINHOS, 'UAU Mart', 'image/webp']]);

  const semVinhos = montarLista({ categoriasPorLoja, catalogo: { bebidas: { nome: 'Bebidas' } }, extras: EXTRAS_DE_OUTRAS_LOJAS });
  assert.deepEqual(semVinhos.entraria.map((linha) => linha.categoriaId), ['bebidas'], 'sem Vinhos na lista padrao, fica fora');
  assert.equal(semVinhos.foraDaListaPadrao[0].categoriaId, VINHOS);
  assert.deepEqual(montarLista({ categoriasPorLoja, catalogo: { bebidas: { nome: 'Bebidas' }, [VINHOS]: { nome: 'Vinhos' } } }).entraria.length, 1, 'sem extras, como antes');
});
