import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../../domain/errors/AppError.js';
import {
  ANIMACAO_MAX_BYTES, ANIMACAO_TIPOS, ICONE_DO_CONJUNTO_MAX_BYTES, ICONE_DO_CONJUNTO_TIPOS,
  IMAGEM_DA_APARENCIA_MAX_BYTES, IMAGEM_DA_APARENCIA_TIPOS,
} from '../../domain/loja/aparencias.js';

// Conferencia dos arquivos das Aparencias (cola B56-04): icone de conjunto, imagem e animacao.
// Nada aqui grava no banco; so confere e, para o Storage, devolve a URL com token, no mesmo
// formato dos icones da lista padrao (ManageCatalogoPadrao.trocarIcone).

function recusa(mensagem, code, statusCode = 400) {
  return new AppError(mensagem, { statusCode, code });
}

const kb = (bytes) => Math.ceil(bytes / 1024);

export function decodificar(conteudoBase64) {
  const conteudo = Buffer.from(String(conteudoBase64 || ''), 'base64');
  if (!conteudo.length) throw recusa('Envie o arquivo.', 'aparencia_arquivo_vazio');
  return conteudo;
}

async function medidas(conteudo) {
  try {
    const { width, height } = await sharp(conteudo, { failOn: 'none' }).metadata();
    if (width && height) return { largura: width, altura: height };
  } catch {
    // Cai na leitura do viewBox abaixo (SVG) ou na recusa.
  }
  const svg = conteudo.toString('utf8');
  const viewBox = svg.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i);
  if (viewBox) return { largura: Number(viewBox[1]), altura: Number(viewBox[2]) };
  return null;
}

// PNG acima de 20 KB: tenta WEBP sem perda e depois com qualidade menor, no mesmo tamanho.
async function pngParaWebp(conteudo) {
  const tentativas = [{ lossless: true }, ...[90, 80, 70, 60, 50, 40].map((quality) => ({ quality }))];
  for (const opcoes of tentativas) {
    const saida = await sharp(conteudo, { failOn: 'none' }).webp(opcoes).toBuffer();
    if (saida.length <= ICONE_DO_CONJUNTO_MAX_BYTES) return saida;
  }
  return null;
}

// Icone de conjunto: SVG, PNG ou WEBP, quadrado, ate 20 KB. PNG acima de 20 KB vira WEBP se couber.
export async function conferirIcone(conteudo, tipoArquivo) {
  const extensao = ICONE_DO_CONJUNTO_TIPOS[tipoArquivo];
  if (!extensao) throw recusa('Use um ícone em SVG, PNG ou WEBP.', 'conjunto_icone_tipo');
  const tamanho = await medidas(conteudo);
  if (!tamanho) throw recusa('Não deu para abrir este ícone. Envie um SVG, PNG ou WEBP.', 'conjunto_icone_ilegivel');
  if (Math.abs(tamanho.largura - tamanho.altura) > 0.5) {
    throw recusa(`O ícone precisa ser quadrado (este tem ${tamanho.largura} x ${tamanho.altura}).`, 'conjunto_icone_nao_quadrado');
  }
  if (conteudo.length <= ICONE_DO_CONJUNTO_MAX_BYTES) {
    return { conteudo, extensao, contentType: tipoArquivo, convertido: false };
  }
  if (extensao === 'png') {
    const webp = await pngParaWebp(conteudo);
    if (webp) return { conteudo: webp, extensao: 'webp', contentType: 'image/webp', convertido: true };
    throw recusa(
      `O ícone tem ${kb(conteudo.length)} KB e, mesmo convertido para WEBP, passou de 20 KB. Reduza o arquivo e envie de novo.`,
      'conjunto_icone_tamanho',
    );
  }
  throw recusa(`O ícone tem ${kb(conteudo.length)} KB. O limite é 20 KB: reduza o arquivo e envie de novo.`, 'conjunto_icone_tamanho');
}

// Imagem de Ofertas, Abertura ou Primeira tela: ate 40 KB, sem conversao.
export async function conferirImagem(conteudo, tipoArquivo) {
  const extensao = IMAGEM_DA_APARENCIA_TIPOS[tipoArquivo];
  if (!extensao) throw recusa('Use uma imagem em SVG, PNG, WEBP ou JPG.', 'aparencia_imagem_tipo');
  if (conteudo.length > IMAGEM_DA_APARENCIA_MAX_BYTES) {
    throw recusa(`A imagem tem ${kb(conteudo.length)} KB. O limite é 40 KB: reduza o arquivo e envie de novo.`, 'aparencia_imagem_tamanho');
  }
  if (!(await medidas(conteudo))) throw recusa('Não deu para abrir esta imagem.', 'aparencia_imagem_ilegivel');
  return { conteudo, extensao, contentType: tipoArquivo };
}

// Animacao: .json (Lottie) ate 120 KB, que precisa abrir como objeto JSON.
export function conferirAnimacao(conteudo, tipoArquivo) {
  const extensao = ANIMACAO_TIPOS[tipoArquivo];
  if (!extensao) throw recusa('A animação precisa ser um arquivo .json.', 'aparencia_animacao_tipo');
  if (conteudo.length > ANIMACAO_MAX_BYTES) {
    throw recusa(`A animação tem ${kb(conteudo.length)} KB. O limite é 120 KB: reduza o arquivo e envie de novo.`, 'aparencia_animacao_tamanho');
  }
  let json;
  try {
    json = JSON.parse(conteudo.toString('utf8'));
  } catch {
    json = null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw recusa('Não deu para abrir esta animação: o .json não é válido.', 'aparencia_animacao_invalida');
  }
  return { conteudo, extensao, contentType: 'application/json' };
}

export async function gravarNoStorage(bucket, caminho, conteudo, contentType) {
  if (!bucket) throw recusa('Armazenamento de arquivos não configurado.', 'aparencia_sem_bucket', 503);
  const token = randomUUID();
  await bucket.file(caminho).save(conteudo, {
    contentType,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(caminho)}?alt=media&token=${token}`;
}
