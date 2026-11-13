#!/usr/bin/env node
// Colecao "Padrao" (cola B56-17, 2.2): um icone por categoria da lista padrao (categoriasProdutos),
// com o arquivo de hoje de cada uma, lido do Storage. Categoria sem icone ou com arquivo que nao
// existe no Storage (o todos.svg) fica fora da colecao: nas lojas, sem icone.
//
// Sem --criar, so le e imprime a lista: nao grava nada.
// Com --criar, confere todos os arquivos antes (tipo SVG/PNG/WEBP, quadrado, ate 20 KB, a mesma
// regra do Admin) e, se algum nao passar, para sem gravar. Passando, cria a colecao pelo mesmo
// caminho do Admin (ConjuntosDeIcones: conjuntosIcones/{id} e conjuntosIcones/{id}/{categoria}_{ms}.{ext}).
// Nao marca a colecao como padrao (isso e no Admin, aba Icones) e nao marca nenhuma loja.
//
// So roda contra o emulador, com as travas do montarConjuntoIlustracoes (B56-14, 2.0): leitura com
// FIRESTORE_EMULATOR_HOST local e projeto demo-*; escrita com os dois emuladores locais e demo-rp44.
//
// Uso:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
//     node scripts/montarConjuntoPadrao.mjs [--criar] [--nome Padrão]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJETO_DE_ESCRITA, alvoPermitido, escritaPermitida } from './montarConjuntoIlustracoes.mjs';

export const NOME_DO_CONJUNTO_PADRAO = 'Padrão';

const TIPO_DA_EXTENSAO = Object.freeze({ svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' });

// Bucket e caminho do arquivo a partir do endereco do icone (sem token). Sem bucket no endereco,
// o bucket padrao.
export function objetoNoStorage(url, bucketPadrao) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const firebase = url.match(/\/v0\/b\/([^/]+)\/o\/([^?#]+)/);
  if (firebase) return { bucket: firebase[1], caminho: decodeURIComponent(firebase[2]) };
  const gs = url.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (gs) return { bucket: gs[1], caminho: gs[2] };
  if (/^https?:\/\//i.test(url)) return null;
  return { bucket: bucketPadrao, caminho: url.split('?')[0] };
}

// `catalogo`: [{ id, nome, icon }]. Devolve as categorias com endereco de icone e as sem.
export function montarListaPadrao(catalogo, bucketPadrao) {
  const itens = [];
  const semIcone = [];
  for (const categoria of catalogo) {
    const objeto = objetoNoStorage(categoria.icon, bucketPadrao);
    if (!objeto) { semIcone.push({ categoriaId: categoria.id, nome: categoria.nome || null }); continue; }
    itens.push({ categoriaId: categoria.id, nome: categoria.nome || null, ...objeto });
  }
  itens.sort((a, b) => String(a.nome || a.categoriaId).localeCompare(String(b.nome || b.categoriaId), 'pt-BR'));
  return { itens, semIcone };
}

// `lerArquivo(item)` devolve o Buffer do arquivo ou null (nao existe). `conferir(conteudo, tipo)`
// e a conferencia do Admin (conferirIcone). Arquivo que nao existe vai para semArquivo; o que nao
// passa na conferencia vai para problemas (e o script para sem gravar).
export async function escolherArquivosPadrao(itens, lerArquivo, conferir) {
  const escolhidos = [];
  const semArquivo = [];
  const problemas = [];
  for (const item of itens) {
    const conteudo = await lerArquivo(item);
    if (!conteudo) { semArquivo.push({ categoriaId: item.categoriaId, nome: item.nome, caminho: item.caminho }); continue; }
    const tipoArquivo = TIPO_DA_EXTENSAO[path.extname(item.caminho).slice(1).toLowerCase()];
    if (!tipoArquivo) { problemas.push(`${item.categoriaId}: tipo ${path.extname(item.caminho) || '(sem extensão)'} fora de SVG, PNG ou WEBP`); continue; }
    try {
      await conferir(conteudo, tipoArquivo);
    } catch (error) {
      problemas.push(`${item.categoriaId} (${item.caminho}): ${error?.message}`);
      continue;
    }
    escolhidos.push({ ...item, tipoArquivo, bytes: conteudo.length, conteudo });
  }
  return { escolhidos, semArquivo, problemas };
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
      ? 'Recusado: para criar a coleção, precisa de FIRESTORE_EMULATOR_HOST e FIREBASE_STORAGE_EMULATOR_HOST locais e do projeto demo-rp44. Nada foi gravado.'
      : 'Recusado: este script só roda contra o emulador (FIRESTORE_EMULATOR_HOST=127.0.0.1:porta) com projeto demo-*.');
    process.exit(2);
  }
  if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    console.error('Recusado: precisa do emulador do Storage (FIREBASE_STORAGE_EMULATOR_HOST) para ler os arquivos. Nada foi gravado.');
    process.exit(2);
  }
  if (!process.env.STORAGE_EMULATOR_HOST) process.env.STORAGE_EMULATOR_HOST = `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`;
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getStorage } = await import('firebase-admin/storage');
  const { conferirIcone } = await import('../src/application/loja/arquivosDaAparencia.js');
  const bucketNome = `${projeto}.appspot.com`;
  const app = initializeApp({ projectId: projeto, storageBucket: bucketNome }, 'montar-conjunto-padrao');
  const firestore = getFirestore(app);
  const storage = getStorage(app);
  const snapshot = await firestore.collection('categoriasProdutos').get();
  const catalogo = snapshot.docs.map((documento) => ({ id: documento.id, nome: documento.data().name || null, icon: documento.data().icon || null }));
  const { itens, semIcone } = montarListaPadrao(catalogo, bucketNome);
  const lerArquivo = async (item) => {
    const arquivo = storage.bucket(item.bucket).file(item.caminho);
    const [existe] = await arquivo.exists();
    if (!existe) return null;
    const [conteudo] = await arquivo.download();
    return conteudo;
  };
  const { escolhidos, semArquivo, problemas } = await escolherArquivosPadrao(itens, lerArquivo, conferirIcone);
  const resumo = { categoriasNaLista: catalogo.length, entram: escolhidos.length, semIcone: semIcone.length, semArquivo: semArquivo.length, problemas: problemas.length };
  if (!criar || problemas.length) {
    console.log(JSON.stringify({
      projeto, lidoEm: new Date().toISOString(), resumo,
      entram: escolhidos.map(({ conteudo, ...item }) => item), semIcone, semArquivo, problemas,
    }, null, 2));
    if (criar) { console.error('Parado antes de gravar: há arquivos que não passam na conferência.'); process.exit(1); }
    return;
  }
  const { ConjuntosDeIcones } = await import('../src/application/admin/ConjuntosDeIcones.js');
  const conjuntos = new ConjuntosDeIcones({ firestore, bucket: storage.bucket(bucketNome) });
  const ator = { uid: 'script:montarConjuntoPadrao' };
  const conjunto = await conjuntos.criar({ nome: argumento('--nome') || NOME_DO_CONJUNTO_PADRAO }, ator);
  const gravados = [];
  for (const item of escolhidos) {
    const resultado = await conjuntos.trocarIcone(conjunto.id, item.categoriaId, { conteudoBase64: item.conteudo.toString('base64'), tipoArquivo: item.tipoArquivo }, ator);
    gravados.push({ categoriaId: item.categoriaId, nome: item.nome, arquivoDeOrigem: item.caminho, bytes: resultado.bytes, arquivoNoConjunto: resultado.conjunto.icones[item.categoriaId].arquivo });
  }
  console.log(JSON.stringify({ projeto, criadoEm: new Date().toISOString(), conjunto: { id: conjunto.id, nome: conjunto.nome, icones: gravados.length }, resumo, gravados, semIcone, semArquivo }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Falhou:', error?.message);
    process.exit(1);
  });
}
