import { isDeepStrictEqual } from 'node:util';
import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { chaveDoNome } from '../../domain/catalogo/formatarNome.js';
import {
  BLOCOS, FAIXAS, NUMEROS, VARIACAO_PADRAO, VARIACOES, ajustesDaVariacao, ajustesFinais, conferirAjustes, numeroValido,
} from '../../domain/loja/variacoesDaHome.js';
import { COLECAO_DE_MODELOS, DOCUMENTO_DE_PADROES } from '../loja/AppDoClienteDaLoja.js';

// Modelos e padroes das variacoes da Inicio (cola B56-08, B3 e B4), so pelo Admin.
// - modelosAparencia/{id}: { bloco, nome, base, ajustes, criadoEm, atualizadoEm, atualizadoPor }.
// - aparenciaPadrao/padroes: { topo: { '2': {ajustes} }, meio: {...}, fim: {...} }, os ajustes que
//   substituem os da tabela (variacoesDaHome.js) para todas as lojas.
// - Na loja, aparenciaHome.{bloco}, {bloco}Modelo e {bloco}Ajustes (os ajustes finais ja resolvidos).
// Salvar um modelo ou um padrao regrava os ajustes finais das lojas afetadas, em lotes.
const LOTE = 400;

function recusa(mensagem, code, statusCode = 400, details) {
  return new AppError(mensagem, { statusCode, code, details });
}

const quandoIso = (valor) => {
  const data = typeof valor?.toDate === 'function' ? valor.toDate() : valor;
  return data instanceof Date && !Number.isNaN(data.getTime()) ? data.toISOString() : null;
};

function blocoValido(bloco) {
  if (!BLOCOS.includes(bloco)) throw recusa('Bloco inválido. Use topo, meio ou fim.', 'bloco_invalido');
  return bloco;
}

function numeroDe(bloco, numero) {
  const valor = Number(numero);
  if (!numeroValido(bloco, valor)) throw recusa(`Variação de ${bloco} inválida.`, 'variacao_invalida');
  return valor;
}

function conferidos(bloco, ajustes, numero) {
  const { ajustes: limpo, problemas } = conferirAjustes(bloco, ajustes, { numero });
  if (problemas.length) throw recusa(`Ajuste fora da faixa: ${problemas.join('; ')}.`, 'ajuste_fora_da_faixa', 400, { problemas });
  return limpo;
}

// Variacao e modelo de um bloco da loja; sem gravacao, a variacao padrao (2) e sem modelo.
export function escolhaDaLoja(aparenciaHome, bloco) {
  const home = aparenciaHome && typeof aparenciaHome === 'object' ? aparenciaHome : {};
  const modelo = typeof home[`${bloco}Modelo`] === 'string' && home[`${bloco}Modelo`] ? home[`${bloco}Modelo`] : null;
  const numero = numeroValido(bloco, home[bloco]) ? home[bloco] : VARIACAO_PADRAO[bloco];
  return { numero, modelo };
}

export class AparenciaDaHome {
  constructor({ firestore, serverTimestamp = () => FieldValue.serverTimestamp(), apagarCampo = () => FieldValue.delete() }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
    this.apagarCampo = apagarCampo;
  }

  modelos() {
    return this.firestore.collection(COLECAO_DE_MODELOS);
  }

  async padroes() {
    return (await this.firestore.doc(DOCUMENTO_DE_PADROES).get()).data() || {};
  }

  // Uma leitura de todas as lojas (so aparenciaHome): quem usa cada variacao e cada modelo.
  async lojas() {
    const snapshot = await this.firestore.collection('estabelecimentos').select('aparenciaHome').get();
    return snapshot.docs.map((documento) => ({ ref: documento.ref, id: documento.id, home: documento.data()?.aparenciaHome || {} }));
  }

  usaModelo(loja, bloco, modeloId) {
    return escolhaDaLoja(loja.home, bloco).modelo === modeloId;
  }

  usaVariacao(loja, bloco, numero) {
    const escolha = escolhaDaLoja(loja.home, bloco);
    return !escolha.modelo && escolha.numero === numero;
  }

  // Cola B56-21 (Passo 0): a loja da variacao tem ajuste proprio quando o {bloco}Ajustes gravado
  // e diferente dos ajustes da variacao antes da mudanca (a tabela com o padrao de entao). Sem
  // ajustes gravados, nao tem.
  temAjusteProprio(loja, bloco, ajustesAntes) {
    const gravados = loja.home?.[`${bloco}Ajustes`];
    if (!gravados || typeof gravados !== 'object' || Array.isArray(gravados)) return false;
    return !isDeepStrictEqual({ ...gravados }, { ...ajustesAntes });
  }

  // As lojas da variacao (sem modelo), separadas em sem e com ajuste proprio.
  lojasDaVariacao(lojas, bloco, numero, padroes) {
    const antes = ajustesDaVariacao(bloco, numero, padroes);
    const daVariacao = lojas.filter((loja) => this.usaVariacao(loja, bloco, numero));
    return {
      semAjuste: daVariacao.filter((loja) => !this.temAjusteProprio(loja, bloco, antes)),
      comAjuste: daVariacao.filter((loja) => this.temAjusteProprio(loja, bloco, antes)),
    };
  }

  // A tabela (B1), as faixas (B2) e os padroes mudados, para a tela.
  async variacoes() {
    const padroes = await this.padroes();
    const resolvidas = Object.fromEntries(BLOCOS.map((bloco) => [bloco, Object.fromEntries(
      Array.from({ length: NUMEROS[bloco] }, (_, indice) => {
        const numero = indice + 1;
        return [numero, { ajustes: ajustesDaVariacao(bloco, numero, padroes), original: VARIACOES[bloco][numero], padraoMudado: Boolean(padroes?.[bloco]?.[String(numero)]) }];
      }),
    )]));
    return { numeros: NUMEROS, faixas: FAIXAS, variacoes: resolvidas };
  }

  paraATela(documento, lojas = null) {
    const data = documento.data() || {};
    return {
      id: documento.id,
      bloco: data.bloco,
      nome: data.nome || documento.id,
      base: data.base,
      ajustes: data.ajustes || {},
      lojas,
      criadoEm: quandoIso(data.criadoEm),
      atualizadoEm: quandoIso(data.atualizadoEm),
      atualizadoPor: data.atualizadoPor || null,
    };
  }

  // B4.a: modelos por bloco (ou todos), cada um com quantas lojas o usam. Ordem de criacao.
  async listarModelos(bloco = null) {
    if (bloco) blocoValido(bloco);
    const [snapshot, lojas] = await Promise.all([
      bloco ? this.modelos().where('bloco', '==', bloco).get() : this.modelos().get(),
      this.lojas(),
    ]);
    return snapshot.docs
      .map((documento) => this.paraATela(documento, lojas.filter((loja) => this.usaModelo(loja, documento.data()?.bloco, documento.id)).length))
      .sort((a, b) => String(a.criadoEm || '').localeCompare(String(b.criadoEm || '')) || a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  async modelo(id) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(id || ''))) throw recusa('Modelo não encontrado.', 'modelo_nao_encontrado', 404);
    const documento = await this.modelos().doc(id).get();
    if (!documento.exists) throw recusa('Modelo não encontrado.', 'modelo_nao_encontrado', 404);
    return documento;
  }

  async assertNomeLivre(bloco, nome, ignorarId = null) {
    const limpo = String(nome || '').trim().replace(/\s+/g, ' ');
    if (!limpo || limpo.length > 60) throw recusa('Dê um nome de até 60 letras.', 'modelo_nome_invalido');
    const chave = chaveDoNome(limpo);
    const snapshot = await this.modelos().where('bloco', '==', bloco).get();
    const repetido = snapshot.docs.some((documento) => documento.id !== ignorarId && chaveDoNome(documento.data()?.nome || '') === chave);
    const daVariacao = Array.from({ length: NUMEROS[bloco] }, (_, indice) => chaveDoNome(`${bloco} ${indice + 1}`)).includes(chave);
    if (repetido || daVariacao) throw recusa('Já existe um modelo com esse nome.', 'modelo_nome_repetido', 409);
    return limpo;
  }

  // B4.b: o modelo guarda os ajustes completos (os da base, com os enviados por cima).
  async criarModelo({ nome, bloco, base, ajustes = {} } = {}, ator = {}) {
    blocoValido(bloco);
    const numero = numeroDe(bloco, base);
    const limpo = await this.assertNomeLivre(bloco, nome);
    const completos = { ...ajustesDaVariacao(bloco, numero, await this.padroes()), ...conferidos(bloco, ajustes, numero) };
    const quando = this.serverTimestamp();
    const ref = await this.modelos().add({
      bloco, nome: limpo, base: numero, ajustes: completos, criadoEm: quando, atualizadoEm: quando, atualizadoPor: ator.uid || null,
    });
    return this.paraATela(await ref.get(), 0);
  }

  // Regrava {bloco}Ajustes nas lojas, em lotes. `ajustesDe(loja)` devolve os ajustes finais.
  async regravar(lojas, bloco, ajustesDe) {
    for (let inicio = 0; inicio < lojas.length; inicio += LOTE) {
      const lote = this.firestore.batch();
      lojas.slice(inicio, inicio + LOTE).forEach((loja) => {
        lote.update(loja.ref, { [`aparenciaHome.${bloco}Ajustes`]: ajustesDe(loja), updatedAt: this.serverTimestamp() });
      });
      await lote.commit();
    }
    return lojas.map((loja) => loja.id);
  }

  // B4.c: grava o modelo e regrava as lojas que usam esse modelo.
  async salvarModelo(id, { nome, ajustes = {} } = {}, ator = {}) {
    const atual = await this.modelo(id);
    const data = atual.data() || {};
    const mudancas = { atualizadoEm: this.serverTimestamp(), atualizadoPor: ator.uid || null };
    if (nome !== undefined) mudancas.nome = await this.assertNomeLivre(data.bloco, nome, atual.id);
    const novos = { ...(data.ajustes || {}), ...conferidos(data.bloco, ajustes, data.base) };
    mudancas.ajustes = novos;
    await atual.ref.update(mudancas);
    const padroes = await this.padroes();
    const modelo = { base: data.base, ajustes: novos };
    const afetadas = (await this.lojas()).filter((loja) => this.usaModelo(loja, data.bloco, atual.id));
    const ids = await this.regravar(afetadas, data.bloco, () => ajustesFinais(data.bloco, { modelo, padroes }));
    return { modelo: this.paraATela(await atual.ref.get(), afetadas.length), lojasAlteradas: ids.length, lojas: ids, antes: data.ajustes || {} };
  }

  // B4.d: o padrao de uma variacao para as lojas que a usam sem modelo. Cola B56-21: so as sem
  // ajuste proprio; as com ajuste proprio so com `incluirAjusteProprio` (a caixa da janela).
  async mudarPadrao(bloco, numero, ajustes = {}, ator = {}, { incluirAjusteProprio = false } = {}) {
    blocoValido(bloco);
    const valor = numeroDe(bloco, numero);
    const padroes = await this.padroes();
    const antes = padroes?.[bloco]?.[String(valor)] || null;
    const novos = { ...(antes || {}), ...conferidos(bloco, ajustes, valor) };
    const { semAjuste, comAjuste } = this.lojasDaVariacao(await this.lojas(), bloco, valor, padroes);
    await this.firestore.doc(DOCUMENTO_DE_PADROES).set({
      [bloco]: { ...(padroes[bloco] || {}), [String(valor)]: novos },
      atualizadoEm: this.serverTimestamp(),
      atualizadoPor: ator.uid || null,
    }, { merge: true });
    const final = ajustesDaVariacao(bloco, valor, { [bloco]: { [String(valor)]: novos } });
    const afetadas = incluirAjusteProprio ? [...semAjuste, ...comAjuste] : semAjuste;
    const ids = await this.regravar(afetadas, bloco, () => final);
    return { bloco, numero: valor, ajustes: final, lojasAlteradas: ids.length, lojas: ids, lojasComAjusteProprio: comAjuste.length, antes };
  }

  // B4.e: apaga o padrao mudado e regrava as lojas com a tabela. Cola B56-21: a mesma regra do
  // mudarPadrao; e so a chave desta variacao sai do documento (os outros blocos e as outras
  // variacoes continuam como estao).
  async voltarAoOriginal(bloco, numero, ator = {}, { incluirAjusteProprio = false } = {}) {
    blocoValido(bloco);
    const valor = numeroDe(bloco, numero);
    const padroes = await this.padroes();
    const antes = padroes?.[bloco]?.[String(valor)] || null;
    if (!antes) throw recusa('Esta variação já está no original.', 'padrao_ja_original', 409);
    const { semAjuste, comAjuste } = this.lojasDaVariacao(await this.lojas(), bloco, valor, padroes);
    const restantes = { ...(padroes[bloco] || {}) };
    delete restantes[String(valor)];
    await this.firestore.doc(DOCUMENTO_DE_PADROES).update({
      [bloco]: restantes, atualizadoEm: this.serverTimestamp(), atualizadoPor: ator.uid || null,
    });
    const final = { ...VARIACOES[bloco][valor] };
    const afetadas = incluirAjusteProprio ? [...semAjuste, ...comAjuste] : semAjuste;
    const ids = await this.regravar(afetadas, bloco, () => final);
    return { bloco, numero: valor, ajustes: final, lojasAlteradas: ids.length, lojas: ids, lojasComAjusteProprio: comAjuste.length, antes };
  }

  // B4.f: quantas lojas uma gravacao vai mudar, para a janela de confirmacao. Na variacao (cola
  // B56-21): `lojas` sem ajuste proprio (N) e `comAjusteProprio` (M), que so mudam com a caixa.
  async afetadas({ bloco, numero, modeloId } = {}) {
    const lojas = await this.lojas();
    if (modeloId) {
      const documento = await this.modelo(modeloId);
      return { lojas: lojas.filter((loja) => this.usaModelo(loja, documento.data()?.bloco, documento.id)).length };
    }
    blocoValido(bloco);
    const valor = numeroDe(bloco, numero);
    const { semAjuste, comAjuste } = this.lojasDaVariacao(lojas, bloco, valor, await this.padroes());
    return { lojas: semAjuste.length, comAjusteProprio: comAjuste.length };
  }
}
