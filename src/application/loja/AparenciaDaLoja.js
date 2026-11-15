import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import {
  ARQUIVOS_DA_APARENCIA, ARQUIVOS_DO_FUNDO, aberturaDaLoja, conjuntoDaLoja, ofertasDaLoja, primeiraTelaDaLoja,
} from '../../domain/loja/aparencias.js';
import { blocoDaLoja, coresPadraoDe } from '../../domain/loja/primeiroAcesso.js';
import { conferirAnimacao, conferirImagem, decodificar, gravarNoStorage } from './arquivosDaAparencia.js';

// Cola B56-24 (A2): animacao padrao da Abertura de todas as lojas. Leitura aberta na regra (o app
// le antes do login); gravacao so pelo Core.
export const DOCUMENTO_DA_ABERTURA_PADRAO = 'aparenciaPadrao/abertura';
// Cola B56-25 (item 7): cores das lojas novas. So o Core le e grava (regra fechada).
export const DOCUMENTO_DAS_CORES_PADRAO = 'aparenciaPadrao/cores';
const LOTE = 400;

// Ofertas, Abertura e Primeira tela da loja (cola B56-04, parte 3). Mesmo padrao do
// AppDoClienteDaLoja: cada chave gravada sozinha (ofertas.fundo.tipo, abertura.cor...), com o
// valor de antes para a auditoria. O Admin grava tudo; o lojista grava so ofertas.fundo, e so
// quando ofertas.lojistaPodeTrocarFundo esta ligado. A cor do fundo e o offerColor de hoje
// enquanto ofertas.fundo.cor nao existir; a imagem da Abertura e o splashImageUrl de hoje.
function recusa(mensagem, code, statusCode = 400) {
  return new AppError(mensagem, { statusCode, code });
}

// Achata { ofertas: { fundo: { tipo } } } em { 'ofertas.fundo.tipo': valor }. null apaga a chave.
function achatar(entrada, prefixo = '') {
  return Object.entries(entrada || {}).flatMap(([chave, valor]) => {
    const caminho = prefixo ? `${prefixo}.${chave}` : chave;
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? achatar(valor, caminho) : [[caminho, valor]];
  });
}

function valorEm(data, caminho) {
  return caminho.split('.').reduce((atual, parte) => (atual && typeof atual === 'object' ? atual[parte] : undefined), data);
}

export class AparenciaDaLoja {
  constructor({ firestore, bucket = null, serverTimestamp = () => FieldValue.serverTimestamp(), apagarCampo = () => FieldValue.delete(), agora = () => Date.now() }) {
    this.firestore = firestore;
    this.bucket = bucket;
    this.serverTimestamp = serverTimestamp;
    this.apagarCampo = apagarCampo;
    this.agora = agora;
  }

  lojaRef(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(String(lojaId || ''));
  }

  async ler(lojaId) {
    const [loja, padrao] = await Promise.all([this.lojaRef(lojaId).get(), this.aberturaPadrao()]);
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    return { ...paraATela(loja.id, loja.data() || {}), aberturaPadrao: padrao };
  }

  async aberturaPadrao() {
    const documento = await this.firestore.doc(DOCUMENTO_DA_ABERTURA_PADRAO).get();
    const data = documento.exists ? documento.data() || {} : {};
    return {
      nome: typeof data.nome === 'string' && data.nome ? data.nome : null,
      animacaoUrl: typeof data.animacaoUrl === 'string' && data.animacaoUrl ? data.animacaoUrl : null,
    };
  }

  // Cola B56-25 (item 7): cores com que as lojas novas nascem. As lojas que ja existem nao mudam.
  async coresPadrao() {
    const documento = await this.firestore.doc(DOCUMENTO_DAS_CORES_PADRAO).get();
    return coresPadraoDe(documento.exists ? documento.data() || {} : {});
  }

  async mudarCoresPadrao({ loja, sistema }, ator = {}) {
    const antes = await this.coresPadrao();
    const depois = coresPadraoDe({ loja, sistema });
    await this.firestore.doc(DOCUMENTO_DAS_CORES_PADRAO).set({
      ...depois, atualizadoEm: this.serverTimestamp(), atualizadoPor: ator.uid || null,
    }, { merge: true });
    return { ...depois, antes };
  }

  // Lojas sem animacao propria (usam a padrao) e com animacao propria (abertura.animacaoUrl).
  async lojasDaAbertura() {
    const snapshot = await this.firestore.collection('estabelecimentos').select('abertura').get();
    const semPropria = [];
    const comPropria = [];
    snapshot.forEach((loja) => {
      (blocoDaLoja('abertura', loja.data() || {}).animacaoUrl ? comPropria : semPropria).push(loja);
    });
    return { semPropria, comPropria };
  }

  // Para a janela de confirmacao do Admin: "vale para N lojas" e "as M lojas com animacao propria".
  async padraoDaAbertura() {
    const [padrao, { semPropria, comPropria }] = await Promise.all([this.aberturaPadrao(), this.lojasDaAbertura()]);
    return { ...padrao, lojas: semPropria.length, comAnimacaoPropria: comPropria.length };
  }

  // Troca a animacao padrao de todas as lojas. Com incluirAnimacaoPropria (a caixa da janela),
  // apaga abertura.animacaoUrl das lojas com animacao propria, que passam a usar a padrao.
  async trocarAnimacaoPadrao({ conteudoBase64, tipoArquivo, nome } = {}, ator = {}, { incluirAnimacaoPropria = false } = {}) {
    const arquivo = conferirAnimacao(decodificar(conteudoBase64), tipoArquivo);
    const antes = await this.aberturaPadrao();
    const caminho = `appMobile/aparenciaPadrao/abertura/animacao_${this.agora()}.json`;
    const url = await gravarNoStorage(this.bucket, caminho, arquivo.conteudo, arquivo.contentType);
    const nomeFinal = String(nome || '').trim().slice(0, 120) || 'animacao.json';
    const { semPropria, comPropria } = await this.lojasDaAbertura();
    await this.firestore.doc(DOCUMENTO_DA_ABERTURA_PADRAO).set({
      nome: nomeFinal, animacaoUrl: url, atualizadoEm: this.serverTimestamp(), atualizadoPor: ator.uid || null,
    }, { merge: true });
    const limpas = incluirAnimacaoPropria ? comPropria : [];
    for (let inicio = 0; inicio < limpas.length; inicio += LOTE) {
      const lote = this.firestore.batch();
      limpas.slice(inicio, inicio + LOTE).forEach((loja) => {
        lote.update(loja.ref, { 'abertura.animacaoUrl': this.apagarCampo(), updatedAt: this.serverTimestamp() });
      });
      await lote.commit();
    }
    return {
      nome: nomeFinal,
      animacaoUrl: url,
      lojasAlteradas: semPropria.length + limpas.length,
      lojasComAnimacaoPropria: comPropria.length,
      lojasLimpas: limpas.map((loja) => loja.id),
      antes,
    };
  }

  // `entrada`: { ofertas?, abertura?, primeiraTela?, e os blocos da jornada (B56-24) }, ja conferida pela rota. `soFundo`: a
  // gravacao do lojista, que so passa com ofertas.lojistaPodeTrocarFundo ligado.
  async salvar(lojaId, entrada = {}, { soFundo = false } = {}) {
    const ref = this.lojaRef(lojaId);
    const resultado = await this.firestore.runTransaction(async (transacao) => {
      const loja = await transacao.get(ref);
      if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
      const atual = loja.data() || {};
      if (soFundo) assertLojistaPodeTrocarFundo(atual);
      const mudancas = {};
      const antes = {};
      achatar(entrada).forEach(([caminho, valor]) => {
        if (soFundo && !caminho.startsWith('ofertas.fundo.')) throw recusa('O lojista só troca o fundo de Ofertas.', 'ofertas_so_fundo', 403);
        mudancas[caminho] = valor === null ? this.apagarCampo() : valor;
        antes[caminho] = valorEm(atual, caminho) ?? null;
      });
      if (!Object.keys(mudancas).length) throw recusa('Nada para gravar.', 'aparencia_sem_mudancas');
      transacao.update(ref, { ...mudancas, updatedAt: this.serverTimestamp() });
      return { antes, campos: Object.keys(mudancas) };
    });
    return { ...resultado, aparencia: await this.ler(lojaId) };
  }

  // Envia um arquivo (imagem ate 40 KB ou animacao .json ate 120 KB) e grava a URL no campo
  // do alvo. abertura-imagem grava o splashImageUrl de hoje.
  async enviarArquivo(lojaId, alvo, { conteudoBase64, tipoArquivo } = {}, { soFundo = false } = {}) {
    const destino = ARQUIVOS_DA_APARENCIA[alvo];
    if (!destino) throw recusa('Arquivo de aparência inválido.', 'aparencia_alvo_invalido');
    if (soFundo && !Object.values(ARQUIVOS_DO_FUNDO).includes(alvo)) {
      throw recusa('O lojista só troca o fundo de Ofertas.', 'ofertas_so_fundo', 403);
    }
    const ref = this.lojaRef(lojaId);
    const loja = await ref.get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    const atual = loja.data() || {};
    if (soFundo) assertLojistaPodeTrocarFundo(atual);
    const conteudo = decodificar(conteudoBase64);
    const arquivo = destino.tipo === 'animacao'
      ? conferirAnimacao(conteudo, tipoArquivo)
      : await conferirImagem(conteudo, tipoArquivo, { tipos: destino.tipos, maxBytes: destino.maxBytes });
    const caminho = `appMobile/companyImages/${loja.id}/aparencia/${alvo}_${this.agora()}.${arquivo.extensao}`;
    const url = await gravarNoStorage(this.bucket, caminho, arquivo.conteudo, arquivo.contentType);
    await ref.update({ [destino.campo]: url, updatedAt: this.serverTimestamp() });
    return {
      antes: { [destino.campo]: valorEm(atual, destino.campo) ?? null },
      campos: [destino.campo],
      bytes: arquivo.conteudo.length,
      aparencia: await this.ler(loja.id),
    };
  }
}

function assertLojistaPodeTrocarFundo(data) {
  if (!ofertasDaLoja(data).lojistaPodeTrocarFundo) {
    throw recusa('A troca do fundo de Ofertas não está liberada para esta loja. Fale com a Mobile.', 'ofertas_fundo_travado', 403);
  }
}

function paraATela(lojaId, data) {
  return {
    lojaId,
    conjuntoIcones: conjuntoDaLoja(data),
    ofertas: ofertasDaLoja(data),
    abertura: aberturaDaLoja(data),
    primeiraTela: primeiraTelaDaLoja(data),
    boasVindas: blocoDaLoja('boasVindas', data),
    login: blocoDaLoja('login', data),
    codigoSms: blocoDaLoja('codigoSms', data),
    folhaNome: blocoDaLoja('folhaNome', data),
    folhaEndereco: blocoDaLoja('folhaEndereco', data),
  };
}
