import { HistoricoDoProdutoRepository } from '../../domain/produtos/HistoricoDoProdutoRepository.js';
import { logger as loggerPadrao } from '../logger/logger.js';
import { lerConfiguracaoDoErp } from './configuracaoDoErp.js';

// Leitura de estabelecimentos/{loja}/AcoesEquipe por alvo.id (cola 65, item 3.5).
//
// A consulta ordenada (alvo.tipo == 'produto', alvo.id == produto, em desc) precisa de um indice
// composto que o projeto ainda nao tem (AcoesEquipe: alvo.tipo ASC, alvo.id ASC, em DESC). Sem o
// indice, o Firestore recusa com FAILED_PRECONDITION e a leitura cai para so os filtros de igualdade
// (indices simples, automaticos),
// limitada a LIMITE_SEM_INDICE linhas, e o caso de uso ordena em memoria. Com o indice criado, a
// primeira consulta passa a valer sozinha, sem mudar codigo.
export const LIMITE_SEM_INDICE = 500;

function textoOuNull(valor) {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : null;
}

// Nome como a sessao do Core monta para o funcionario (firstName + lastName).
function nomeDaPessoa(dados = {}) {
  return textoOuNull([dados?.firstName, dados?.lastName].map(textoOuNull).filter(Boolean).join(' '));
}

// Id do Users em userReference (referencia do Firestore, { id, path } ou o caminho em texto). So
// documento da colecao Users.
function idDoUsers(referencia) {
  if (!referencia) return null;
  const caminho = typeof referencia === 'string' ? referencia : (typeof referencia.path === 'string' ? referencia.path : null);
  if (caminho !== null) {
    const partes = caminho.split('/').filter(Boolean);
    return partes.length === 2 && partes[0] === 'Users' ? partes[1] : null;
  }
  return typeof referencia.id === 'string' && referencia.id && !referencia.id.includes('/') ? referencia.id : null;
}

export function faltaIndice(error) {
  return error?.code === 9
    || error?.code === 'failed-precondition'
    || /FAILED_PRECONDITION|requires an index/i.test(String(error?.message || ''));
}

export class FirestoreHistoricoDoProdutoRepository extends HistoricoDoProdutoRepository {
  constructor({ firestore, auth = null, logger = loggerPadrao }) {
    super();
    this.firestore = firestore;
    this.auth = auth;
    this.logger = logger;
  }

  // ===== Quem da linha (Cola 70, item 8) =====
  // Equipe da loja: estabelecimentos/{loja}/AdminUsers/{uid}. So o nome sai daqui.

  equipe(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(lojaId).collection('AdminUsers');
  }

  async nomeNaEquipePorUid({ lojaId, uid }) {
    const documento = await this.equipe(lojaId).doc(uid).get();
    return documento.exists ? nomeDaPessoa(documento.data()) : null;
  }

  async nomeNaEquipePorEmail({ lojaId, email }) {
    const variantes = [...new Set([email, email.toLowerCase()])];
    for (const variante of variantes) {
      const snapshot = await this.equipe(lojaId).where('email', '==', variante).limit(1).get();
      if (!snapshot.empty) return nomeDaPessoa(snapshot.docs[0].data());
    }
    return null;
  }

  // Dono da loja (Cola 71, item 2): o Users apontado em estabelecimentos/{loja}.userReference, a
  // mesma regra do Core para achar o dono (FirestoreEstablishmentAccessRepository, avisoDeCupom.js).
  // Nome do cadastro: Users/{id}.name e, no cadastro antigo, Users/{id}.nome. Devolve so o que o
  // caso de uso precisa para reconhecer o dono na linha (uid e e-mail, que nao saem na resposta) e o
  // nome; sem dono, null.
  async donoDaLoja({ lojaId }) {
    const loja = await this.firestore.collection('estabelecimentos').doc(lojaId).get();
    const usuarioId = idDoUsers(loja.exists ? loja.data()?.userReference : null);
    if (!usuarioId) return null;
    const usuario = await this.firestore.collection('Users').doc(usuarioId).get();
    if (!usuario.exists) return null;
    const dados = usuario.data() || {};
    return {
      uid: textoOuNull(dados.userAuthId),
      email: textoOuNull(dados.email),
      nome: textoOuNull(dados.name) || textoOuNull(dados.nome),
    };
  }

  // Chave do ERP da loja (Cola 71, item 3): documento da loja e IntegrationStatus/current.
  async configuracaoDoErp({ lojaId }) {
    return lerConfiguracaoDoErp(this.firestore, lojaId);
  }

  // E-mail de um uid sem cadastro na Equipe: o Users da conta (userAuthId) e, sem ele, o Auth.
  async emailDoUid(uid) {
    const usuarios = await this.firestore.collection('Users').where('userAuthId', '==', uid).limit(1).get();
    const doUsers = usuarios.empty ? null : textoOuNull(usuarios.docs[0].data()?.email);
    if (doUsers) return doUsers;
    if (!this.auth) return null;
    try {
      const conta = await this.auth.getUser(uid);
      return textoOuNull(conta?.email);
    } catch (error) {
      if (error?.code === 'auth/user-not-found') return null;
      throw error;
    }
  }

  async linhasDoProduto({ lojaId, produtoId, limite }) {
    const consulta = this.firestore
      .collection('estabelecimentos').doc(lojaId)
      .collection('AcoesEquipe')
      .where('alvo.tipo', '==', 'produto')
      .where('alvo.id', '==', produtoId);
    const emLinhas = (snapshot) => snapshot.docs.map((documento) => ({ id: documento.id, ...(documento.data() || {}) }));
    try {
      const snapshot = await consulta.orderBy('em', 'desc').limit(limite).get();
      return { linhas: emLinhas(snapshot), completo: true };
    } catch (error) {
      if (!faltaIndice(error)) throw error;
      this.logger.warn?.('historico_do_produto_sem_indice', { colecao: 'AcoesEquipe' });
      const snapshot = await consulta.limit(LIMITE_SEM_INDICE).get();
      return { linhas: emLinhas(snapshot), completo: snapshot.docs.length < LIMITE_SEM_INDICE };
    }
  }
}
