#!/usr/bin/env node
// Conjunto "Ilustracoes" (cola B56-04, item 2.5; ajuste da cola B56-14, parte 2): le os icones
// das categorias da Zero Grau e da G&S, casa cada categoria com a da lista padrao
// (categoriasProdutos) de mesmo id e gera a lista do que entra no conjunto.
//
// Sem --criar, so le e imprime a lista: nao grava nada.
// Com --criar --origem <pasta>, cria o conjunto no emulador, com um icone por categoria padrao,
// pelo mesmo caminho do Admin (ConjuntosDeIcones: conjuntosIcones/{id} e, no Storage,
// conjuntosIcones/{id}/{categoriaId}_{ms}.{ext}). A <pasta> tem os arquivos das lojas no mesmo
// caminho do Storage (estabelecimentos/{loja}/category_icons/...). Nao marca nenhuma loja.
// Regra da escolha (B56-14, 2.1): categoria com ilustracao nas duas lojas e arquivos iguais, o
// arquivo comum; arquivos diferentes, a loja de ESCOLHA_QUANDO_DIFEREM (so Frios e Lacteos, G&S);
// outra categoria com arquivos diferentes para tudo antes de gravar. Ilustracao em uma loja so, o
// dessa loja. Arquivo sem categoria padrao de mesmo id fica fora (foraDaListaPadrao). Fora das duas
// lojas, so o vinhos.webp da UAU Mart, para Vinhos (EXTRAS_DE_OUTRAS_LOJAS, B56-16); a <pasta> de
// origem precisa ter esse arquivo no mesmo caminho do Storage.
//
// So roda contra o emulador. Leitura: FIRESTORE_EMULATOR_HOST local e projeto demo-*. Escrita
// (--criar): FIRESTORE_EMULATOR_HOST e FIREBASE_STORAGE_EMULATOR_HOST locais e projeto demo-rp44;
// sem os tres, para antes de abrir o banco.
//
// Uso:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/montarConjuntoIlustracoes.mjs [--projeto demo-rp44]
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
//     node scripts/montarConjuntoIlustracoes.mjs --criar --origem <pasta> [--nome Ilustrações]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ICONE_DO_CONJUNTO_MAX_BYTES, ICONE_DO_CONJUNTO_TIPOS } from '../src/domain/loja/aparencias.js';

export const LOJAS = Object.freeze([
  Object.freeze({ id: 'jQQjHTCc2zW1tuZMQzGF', nome: 'Zero Grau' }),
  Object.freeze({ id: 'GkFYWdOBKD1vbzYoem9K', nome: 'G&S' }),
]);

export const NOME_DO_CONJUNTO = 'Ilustrações';
export const PROJETO_DE_ESCRITA = 'demo-rp44';

// Categoria com ilustracao nas duas lojas e arquivos diferentes: a loja escolhida (B56-14).
export const ESCOLHA_QUANDO_DIFEREM = Object.freeze({ frios_e_laticinios: 'G&S' });

// Ilustracoes de outras lojas que entram no conjunto (B56-16, 2.1): so o vinhos.webp da UAU Mart,
// para a categoria padrao Vinhos. Nenhum outro arquivo da UAU Mart. Entra como mais um candidato
// da categoria, com a mesma regra de escolha e as mesmas travas (tipo, 20 KB, arquivo na origem).
export const EXTRAS_DE_OUTRAS_LOJAS = Object.freeze([
  Object.freeze({
    loja: 'UAU Mart',
    lojaId: 'q0IPIusmpEq3pHbMyfWY',
    categoriaId: 'q3lNcbPYgqxGcJuf39EV',
    icone: 'estabelecimentos/q0IPIusmpEq3pHbMyfWY/category_icons/vinhos.webp',
  }),
]);

// So o caminho do arquivo no Storage, sem token nem query.
export function caminhoNoStorage(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const firebase = url.match(/\/o\/([^?]+)/);
  if (firebase) return decodeURIComponent(firebase[1]);
  const gs = url.match(/^gs:\/\/[^/]+\/(.+)$/);
  if (gs) return gs[1];
  return url.split('?')[0];
}

// Icone proprio da loja: o que esta na pasta da loja (estabelecimentos/{loja}/...). O que aponta
// para categoriasProdutos/ ja e um icone da lista padrao e nao entra no conjunto.
export function iconeProprio(caminho, lojaId) {
  return typeof caminho === 'string' && caminho.startsWith(`estabelecimentos/${lojaId}/`);
}

// `categoriasPorLoja`: { [lojaId]: [{ id, nome, icon }] }; `catalogo`: { [id]: { nome } | null }.
// `extras`: ilustracoes de outras lojas (EXTRAS_DE_OUTRAS_LOJAS); entram so se a categoria padrao
// existe no catalogo; sem ela, vao para foraDaListaPadrao.
export function montarLista({ lojas = LOJAS, categoriasPorLoja, catalogo, extras = [] }) {
  const porCategoria = new Map();
  const foraDaListaPadrao = [];
  const jaDaListaPadrao = [];
  const semIcone = [];
  for (const loja of lojas) {
    for (const categoria of categoriasPorLoja[loja.id] || []) {
      const caminho = caminhoNoStorage(categoria.icon);
      const item = { loja: loja.nome, lojaId: loja.id, categoriaId: categoria.id, nomeNaLoja: categoria.nome || null, icone: caminho };
      if (!caminho) { semIcone.push(item); continue; }
      if (!iconeProprio(caminho, loja.id)) { jaDaListaPadrao.push(item); continue; }
      const padrao = catalogo[categoria.id];
      if (!padrao) { foraDaListaPadrao.push(item); continue; }
      const linha = porCategoria.get(categoria.id) || { categoriaId: categoria.id, nomePadrao: padrao.nome || null, candidatos: [] };
      linha.candidatos.push({ loja: loja.nome, nomeNaLoja: item.nomeNaLoja, icone: caminho });
      porCategoria.set(categoria.id, linha);
    }
  }
  for (const extra of extras) {
    const item = { loja: extra.loja, lojaId: extra.lojaId, categoriaId: extra.categoriaId, nomeNaLoja: null, icone: extra.icone };
    const padrao = catalogo[extra.categoriaId];
    if (!padrao) { foraDaListaPadrao.push(item); continue; }
    const linha = porCategoria.get(extra.categoriaId) || { categoriaId: extra.categoriaId, nomePadrao: padrao.nome || null, candidatos: [] };
    linha.candidatos.push({ loja: extra.loja, nomeNaLoja: null, icone: extra.icone });
    porCategoria.set(extra.categoriaId, linha);
  }
  const entraria = [...porCategoria.values()]
    .map((linha) => ({ ...linha, escolha: linha.candidatos.length > 1 ? 'em aberto (as duas lojas têm ícone)' : linha.candidatos[0].loja }))
    .sort((a, b) => String(a.nomePadrao || a.categoriaId).localeCompare(String(b.nomePadrao || b.categoriaId), 'pt-BR'));
  return {
    entraria,
    resumo: {
      categoriasNoConjunto: entraria.length,
      comDuasOpcoes: entraria.filter((linha) => linha.candidatos.length > 1).length,
      foraDaListaPadrao: foraDaListaPadrao.length,
      jaDaListaPadrao: jaDaListaPadrao.length,
      semIcone: semIcone.length,
    },
    foraDaListaPadrao,
    jaDaListaPadrao,
    semIcone,
  };
}

const TIPO_DA_EXTENSAO = Object.freeze(Object.fromEntries(Object.entries(ICONE_DO_CONJUNTO_TIPOS).map(([tipo, extensao]) => [extensao, tipo])));

// Um arquivo por categoria, pela regra da B56-14. `lerArquivo(caminho)` devolve o Buffer do arquivo
// (ou null). Confere tudo antes de devolver: arquivo faltando, tipo fora de SVG/PNG/WEBP, mais de
// 20 KB ou arquivos diferentes sem escolha definida param tudo, sem gravar nada.
export function escolherArquivos(entraria, lerArquivo, escolhas = ESCOLHA_QUANDO_DIFEREM) {
  const problemas = [];
  const escolhidos = [];
  for (const linha of entraria) {
    const arquivos = linha.candidatos.map((candidato) => ({ ...candidato, conteudo: lerArquivo(candidato.icone) }));
    const faltando = arquivos.filter((arquivo) => !arquivo.conteudo);
    if (faltando.length) {
      problemas.push(`${linha.categoriaId}: arquivo não encontrado na origem (${faltando.map((arquivo) => arquivo.icone).join(', ')})`);
      continue;
    }
    let escolhido;
    let origem;
    if (arquivos.length === 1) {
      [escolhido] = arquivos;
      origem = escolhido.loja;
    } else if (arquivos.every((arquivo) => arquivo.conteudo.equals(arquivos[0].conteudo))) {
      [escolhido] = arquivos;
      origem = 'as duas (arquivo igual)';
    } else if (escolhas[linha.categoriaId]) {
      escolhido = arquivos.find((arquivo) => arquivo.loja === escolhas[linha.categoriaId]);
      origem = `${escolhas[linha.categoriaId]} (arquivos diferentes)`;
      if (!escolhido) { problemas.push(`${linha.categoriaId}: a loja escolhida não tem ícone`); continue; }
    } else {
      problemas.push(`${linha.categoriaId}: as duas lojas têm arquivos diferentes e não há escolha definida`);
      continue;
    }
    const extensao = path.extname(escolhido.icone).slice(1).toLowerCase();
    const tipoArquivo = TIPO_DA_EXTENSAO[extensao];
    if (!tipoArquivo) { problemas.push(`${linha.categoriaId}: tipo .${extensao} fora de SVG, PNG ou WEBP`); continue; }
    if (escolhido.conteudo.length > ICONE_DO_CONJUNTO_MAX_BYTES) {
      problemas.push(`${linha.categoriaId}: ${escolhido.conteudo.length} bytes, acima de 20 KB`);
      continue;
    }
    escolhidos.push({
      categoriaId: linha.categoriaId,
      nomePadrao: linha.nomePadrao,
      origem,
      icone: escolhido.icone,
      tipoArquivo,
      bytes: escolhido.conteudo.length,
      conteudo: escolhido.conteudo,
    });
  }
  return { escolhidos, problemas };
}

const hostLocal = (valor) => /^(127\.0\.0\.1|localhost):\d+$/.test(String(valor || ''));

export function alvoPermitido(env = process.env, projeto = 'demo-rp44') {
  return hostLocal(env.FIRESTORE_EMULATOR_HOST) && projeto.startsWith('demo-');
}

// Escrita (B56-14, 2.0): os dois emuladores locais e o projeto demo-rp44, sem excecao.
export function escritaPermitida(env = process.env, projeto = PROJETO_DE_ESCRITA) {
  return hostLocal(env.FIRESTORE_EMULATOR_HOST) && hostLocal(env.FIREBASE_STORAGE_EMULATOR_HOST) && projeto === PROJETO_DE_ESCRITA;
}

function argumento(nome) {
  const indice = process.argv.indexOf(nome);
  return indice > 0 ? process.argv[indice + 1] : undefined;
}

async function main() {
  const projeto = argumento('--projeto') || PROJETO_DE_ESCRITA;
  const criar = process.argv.includes('--criar');
  if (criar ? !escritaPermitida(process.env, projeto) : !alvoPermitido(process.env, projeto)) {
    console.error(criar
      ? 'Recusado: para criar o conjunto, precisa de FIRESTORE_EMULATOR_HOST e FIREBASE_STORAGE_EMULATOR_HOST locais e do projeto demo-rp44. Nada foi gravado.'
      : 'Recusado: este script só roda contra o emulador (FIRESTORE_EMULATOR_HOST=127.0.0.1:porta) com projeto demo-*.');
    process.exit(2);
  }
  const origem = argumento('--origem');
  if (criar && (!origem || !fs.existsSync(origem))) {
    console.error('Recusado: --criar precisa de --origem <pasta> com os arquivos das lojas. Nada foi gravado.');
    process.exit(2);
  }
  if (criar && !process.env.STORAGE_EMULATOR_HOST) process.env.STORAGE_EMULATOR_HOST = `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`;
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const bucketNome = `${projeto}.appspot.com`;
  const app = initializeApp({ projectId: projeto, storageBucket: bucketNome }, 'montar-conjunto-ilustracoes');
  const firestore = getFirestore(app);
  const categoriasPorLoja = {};
  for (const loja of LOJAS) {
    const snapshot = await firestore.collection('estabelecimentos').doc(loja.id).collection('ProductCategories').get();
    categoriasPorLoja[loja.id] = snapshot.docs.map((documento) => ({ id: documento.id, nome: documento.data().name || null, icon: documento.data().icon || null }));
  }
  const ids = [...new Set([...Object.values(categoriasPorLoja).flat().map((categoria) => categoria.id), ...EXTRAS_DE_OUTRAS_LOJAS.map((extra) => extra.categoriaId)])];
  const documentos = ids.length ? await firestore.getAll(...ids.map((id) => firestore.collection('categoriasProdutos').doc(id))) : [];
  const catalogo = Object.fromEntries(documentos.map((documento) => [documento.id, documento.exists ? { nome: documento.data().name || null } : null]));
  const lista = montarLista({ categoriasPorLoja, catalogo, extras: EXTRAS_DE_OUTRAS_LOJAS });
  if (!criar) {
    console.log(JSON.stringify({ projeto, lidoEm: new Date().toISOString(), ...lista }, null, 2));
    return;
  }

  const lerArquivo = (caminho) => {
    const arquivo = path.join(origem, ...caminho.split('/'));
    return fs.existsSync(arquivo) ? fs.readFileSync(arquivo) : null;
  };
  const { escolhidos, problemas } = escolherArquivos(lista.entraria, lerArquivo);
  if (problemas.length) {
    console.error(`Parado antes de gravar:\n- ${problemas.join('\n- ')}`);
    process.exit(1);
  }
  const { getStorage } = await import('firebase-admin/storage');
  const { ConjuntosDeIcones } = await import('../src/application/admin/ConjuntosDeIcones.js');
  const conjuntos = new ConjuntosDeIcones({ firestore, bucket: getStorage(app).bucket(bucketNome) });
  const ator = { uid: 'script:montarConjuntoIlustracoes' };
  const conjunto = await conjuntos.criar({ nome: argumento('--nome') || NOME_DO_CONJUNTO }, ator);
  const gravados = [];
  for (const item of escolhidos) {
    const resultado = await conjuntos.trocarIcone(conjunto.id, item.categoriaId, { conteudoBase64: item.conteudo.toString('base64'), tipoArquivo: item.tipoArquivo }, ator);
    gravados.push({
      categoriaId: item.categoriaId, nomePadrao: item.nomePadrao, origem: item.origem, arquivoDeOrigem: item.icone,
      bytes: resultado.bytes, arquivoNoConjunto: resultado.conjunto.icones[item.categoriaId].arquivo,
    });
  }
  console.log(JSON.stringify({
    projeto,
    criadoEm: new Date().toISOString(),
    conjunto: { id: conjunto.id, nome: conjunto.nome, icones: gravados.length },
    gravados,
    foraDaListaPadrao: lista.foraDaListaPadrao,
    jaDaListaPadrao: lista.jaDaListaPadrao,
    semIcone: lista.semIcone,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Falhou:', error?.message);
    process.exit(1);
  });
}
