import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { chaveDoNome } from '../../domain/catalogo/formatarNome.js';
import { CONJUNTO_LINEARES, ID_SEGURO, conjuntoDaLoja } from '../../domain/loja/aparencias.js';
import { conferirIcone, decodificar, gravarNoStorage } from '../loja/arquivosDaAparencia.js';

// Conjuntos de icones das categorias (cola B56-04, parte 2), so pelo Admin.
// conjuntosIcones/{id}: { nome, icones: { idDaCategoriaPadrao: { url, arquivo } }, criadoEm,
// atualizadoEm, atualizadoPor }. "Lineares" nao tem documento: e a propria lista padrao
// (categoriasProdutos) e aparece primeiro na lista. A loja escolhe por aparencia.conjuntoIcones;
// sem o campo, usa a lista padrao.
const COLECAO = 'conjuntosIcones';
const CATALOGO = 'categoriasProdutos';

function recusa(mensagem, code, statusCode = 400) {
  return new AppError(mensagem, { statusCode, code });
}

const quandoIso = (valor) => {
  const data = typeof valor?.toDate === 'function' ? valor.toDate() : valor;
  return data instanceof Date && !Number.isNaN(data.getTime()) ? data.toISOString() : null;
};

function nomeValido(nome) {
  const limpo = String(nome || '').trim().replace(/\s+/g, ' ');
  if (!limpo || limpo.length > 80) throw recusa('Dê um nome de até 80 letras ao conjunto.', 'conjunto_nome_invalido');
  return limpo;
}

export class ConjuntosDeIcones {
  constructor({ firestore, bucket = null, serverTimestamp = () => FieldValue.serverTimestamp(), apagarCampo = () => FieldValue.delete(), agora = () => Date.now() }) {
    this.firestore = firestore;
    this.bucket = bucket;
    this.serverTimestamp = serverTimestamp;
    this.apagarCampo = apagarCampo;
    this.agora = agora;
  }

  colecao() {
    return this.firestore.collection(COLECAO);
  }

  lojas() {
    return this.firestore.collection('estabelecimentos');
  }

  async conjunto(id) {
    if (id === CONJUNTO_LINEARES.id) {
      throw recusa('"Lineares" é a lista padrão: troque os ícones dela em Categorias.', 'conjunto_lineares_fixo');
    }
    if (!ID_SEGURO.test(String(id || ''))) throw recusa('Conjunto não encontrado.', 'conjunto_nao_encontrado', 404);
    const snapshot = await this.colecao().doc(id).get();
    if (!snapshot.exists) throw recusa('Conjunto não encontrado.', 'conjunto_nao_encontrado', 404);
    return snapshot;
  }

  async contarLojas(conjuntoId) {
    const resultado = await this.lojas().where('aparencia.conjuntoIcones', '==', conjuntoId).count().get();
    return resultado.data().count;
  }

  // Lineares primeiro, depois os conjuntos por nome. Cada um com quantas lojas o usam: uma
  // contagem por conjunto e uma do total de lojas (Lineares = total menos as que tem conjunto).
  async listar() {
    const [snapshot, catalogo, total] = await Promise.all([
      this.colecao().get(),
      this.firestore.collection(CATALOGO).get(),
      this.lojas().count().get(),
    ]);
    const conjuntos = await Promise.all(snapshot.docs.map(async (documento) => {
      const data = documento.data() || {};
      return {
        id: documento.id,
        nome: data.nome || documento.id,
        icones: Object.keys(data.icones || {}).length,
        lojas: await this.contarLojas(documento.id),
        padrao: data.padrao === true,
        atualizadoEm: quandoIso(data.atualizadoEm),
        atualizadoPor: data.atualizadoPor || null,
      };
    }));
    conjuntos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    const comConjunto = conjuntos.reduce((soma, conjunto) => soma + conjunto.lojas, 0);
    const lineares = {
      id: CONJUNTO_LINEARES.id,
      nome: CONJUNTO_LINEARES.nome,
      listaPadrao: true,
      icones: catalogo.docs.filter((documento) => String(documento.data()?.icon || '').trim()).length,
      lojas: Math.max(0, total.data().count - comConjunto),
      atualizadoEm: null,
      atualizadoPor: null,
    };
    return [lineares, ...conjuntos];
  }

  async ler(id) {
    if (id === CONJUNTO_LINEARES.id) {
      const catalogo = await this.firestore.collection(CATALOGO).get();
      return {
        id, nome: CONJUNTO_LINEARES.nome, listaPadrao: true,
        icones: Object.fromEntries(catalogo.docs
          .filter((documento) => String(documento.data()?.icon || '').trim())
          .map((documento) => [documento.id, { url: documento.data().icon, arquivo: documento.data().arquivo || null }])),
      };
    }
    return this.paraATela(await this.conjunto(id));
  }

  paraATela(snapshot) {
    const data = snapshot.data() || {};
    return {
      id: snapshot.id,
      nome: data.nome || snapshot.id,
      listaPadrao: false,
      padrao: data.padrao === true,
      icones: data.icones || {},
      criadoEm: quandoIso(data.criadoEm),
      atualizadoEm: quandoIso(data.atualizadoEm),
      atualizadoPor: data.atualizadoPor || null,
    };
  }

  // Nome repetido (sem acento e sem caixa) e recusado, inclusive "Lineares".
  async assertNomeLivre(nome, ignorarId = null) {
    const chave = chaveDoNome(nome);
    if (chave === chaveDoNome(CONJUNTO_LINEARES.nome)) throw recusa('Já existe um conjunto com esse nome.', 'conjunto_nome_repetido', 409);
    const snapshot = await this.colecao().get();
    const repetido = snapshot.docs.some((documento) => documento.id !== ignorarId && chaveDoNome(documento.data()?.nome || '') === chave);
    if (repetido) throw recusa('Já existe um conjunto com esse nome.', 'conjunto_nome_repetido', 409);
  }

  async criar({ nome } = {}, ator = {}) {
    const limpo = nomeValido(nome);
    await this.assertNomeLivre(limpo);
    const quando = this.serverTimestamp();
    const ref = await this.colecao().add({
      nome: limpo, icones: {}, criadoEm: quando, atualizadoEm: quando, atualizadoPor: ator.uid || null,
    });
    return this.paraATela(await ref.get());
  }

  async renomear(id, { nome } = {}, ator = {}) {
    const atual = await this.conjunto(id);
    const limpo = nomeValido(nome);
    await this.assertNomeLivre(limpo, atual.id);
    await atual.ref.update({ nome: limpo, atualizadoEm: this.serverTimestamp(), atualizadoPor: ator.uid || null });
    return { antes: atual.data()?.nome || null, conjunto: this.paraATela(await atual.ref.get()) };
  }

  async categoriaPadrao(categoriaId) {
    if (!ID_SEGURO.test(String(categoriaId || ''))) throw recusa('Categoria não encontrada na lista padrão.', 'conjunto_categoria_nao_encontrada', 404);
    const snapshot = await this.firestore.collection(CATALOGO).doc(categoriaId).get();
    if (!snapshot.exists) throw recusa('Categoria não encontrada na lista padrão.', 'conjunto_categoria_nao_encontrada', 404);
    return snapshot;
  }

  // Envia ou troca o icone de uma categoria. O arquivo vai para conjuntosIcones/{id}/ no Storage.
  async trocarIcone(id, categoriaId, { conteudoBase64, tipoArquivo } = {}, ator = {}) {
    const atual = await this.conjunto(id);
    await this.categoriaPadrao(categoriaId);
    const icone = await conferirIcone(decodificar(conteudoBase64), tipoArquivo);
    const arquivo = `${categoriaId}_${this.agora()}.${icone.extensao}`;
    const url = await gravarNoStorage(this.bucket, `${COLECAO}/${atual.id}/${arquivo}`, icone.conteudo, icone.contentType);
    await atual.ref.update({
      [`icones.${categoriaId}`]: { url, arquivo },
      atualizadoEm: this.serverTimestamp(),
      atualizadoPor: ator.uid || null,
    });
    return {
      antes: atual.data()?.icones?.[categoriaId] || null,
      convertido: icone.convertido,
      bytes: icone.conteudo.length,
      conjunto: this.paraATela(await atual.ref.get()),
    };
  }

  // Tira o icone da categoria do conjunto: nas lojas que usam o conjunto, a categoria fica sem
  // icone (cola B56-17: so a colecao vale, sem reserva).
  async removerIcone(id, categoriaId, ator = {}) {
    const atual = await this.conjunto(id);
    if (!ID_SEGURO.test(String(categoriaId || ''))) throw recusa('Categoria não encontrada na lista padrão.', 'conjunto_categoria_nao_encontrada', 404);
    const antes = atual.data()?.icones?.[categoriaId] || null;
    if (!antes) throw recusa('Esta categoria não tem ícone neste conjunto.', 'conjunto_icone_ausente', 404);
    await atual.ref.update({
      [`icones.${categoriaId}`]: this.apagarCampo(),
      atualizadoEm: this.serverTimestamp(),
      atualizadoPor: ator.uid || null,
    });
    return { antes, conjunto: this.paraATela(await atual.ref.get()) };
  }

  // Colecao padrao (cola B56-17): vale para a loja sem escolha. So uma por vez: marcar uma tira
  // a marca das outras, na mesma gravacao. Devolve qual era a padrao antes (ou null).
  async marcarPadrao(id, ator = {}) {
    const atual = await this.conjunto(id);
    const marcadas = await this.colecao().where('padrao', '==', true).get();
    const antes = marcadas.docs.map((documento) => documento.id);
    const lote = this.firestore.batch();
    for (const documento of marcadas.docs) {
      if (documento.id !== atual.id) lote.update(documento.ref, { padrao: this.apagarCampo(), atualizadoEm: this.serverTimestamp(), atualizadoPor: ator.uid || null });
    }
    lote.update(atual.ref, { padrao: true, atualizadoEm: this.serverTimestamp(), atualizadoPor: ator.uid || null });
    await lote.commit();
    return { antes: antes.length ? antes.join(',') : null, conjunto: this.paraATela(await atual.ref.get()) };
  }

  // Colecao escolhida pela loja (cola B56-17): "lineares" quando nao escolheu (usa a padrao).
  async daLoja(lojaId) {
    const loja = await this.lojas().doc(String(lojaId || '')).get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    return { lojaId: loja.id, conjuntoIcones: conjuntoDaLoja(loja.data() || {}) };
  }

  // Conjunto da loja. null ou "lineares" apaga o campo: a loja fica sem escolha e usa a colecao
  // padrao (cola B56-17).
  async escolherDaLoja(lojaId, conjuntoId) {
    const ref = this.lojas().doc(String(lojaId || ''));
    const loja = await ref.get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    const antes = conjuntoDaLoja(loja.data() || {});
    const lineares = conjuntoId == null || conjuntoId === CONJUNTO_LINEARES.id;
    if (!lineares) await this.conjunto(conjuntoId);
    await ref.update({
      'aparencia.conjuntoIcones': lineares ? this.apagarCampo() : conjuntoId,
      updatedAt: this.serverTimestamp(),
    });
    return { lojaId: loja.id, antes, conjuntoIcones: lineares ? CONJUNTO_LINEARES.id : conjuntoId };
  }
}
