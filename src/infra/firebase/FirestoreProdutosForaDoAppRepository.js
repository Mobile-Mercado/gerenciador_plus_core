import { ProdutosForaDoAppRepository } from '../../domain/produtos/ProdutosForaDoAppRepository.js';
import { logger as loggerPadrao } from '../logger/logger.js';
import { faltaIndice } from './FirestoreHistoricoDoProdutoRepository.js';
import { lerConfiguracaoDoErp } from './configuracaoDoErp.js';

// Leituras do painel "Produtos fora do app" (cola 65, item 5.1), so da loja da sessao.
//
// Indices: offReasons array-contains com isTrashed == false pode pedir um indice composto
// (Products: offReasons CONTAINS, isTrashed ASC) que o projeto nao tem; ele NAO e criado aqui
// (cola: anotar sem criar). Sem o indice, o Firestore recusa com FAILED_PRECONDITION e a leitura
// repete sem o filtro da lixeira: a lista tira os da lixeira na memoria e a contagem passa a incluir
// os da lixeira com o mesmo motivo (o log avisa). As promocoes usam o indice que ja existe
// (isActive, isTrashed, promotionalPrice); as outras consultas tem um campo so.
const FILTRO_DA_LIXEIRA = 'isTrashed';

function semLixeira(filtros) {
  return filtros.filter(([campo]) => campo !== FILTRO_DA_LIXEIRA);
}

function pedeForaDaLixeira(filtros) {
  return filtros.some(([campo, operador, valor]) => campo === FILTRO_DA_LIXEIRA && operador === '==' && valor === false);
}

export class FirestoreProdutosForaDoAppRepository extends ProdutosForaDoAppRepository {
  constructor({ firestore, logger = loggerPadrao }) {
    super();
    this.firestore = firestore;
    this.logger = logger;
  }

  produtosDaLoja(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(lojaId).collection('Products');
  }

  consulta(lojaId, filtros) {
    return filtros.reduce((consulta, [campo, operador, valor]) => consulta.where(campo, operador, valor), this.produtosDaLoja(lojaId));
  }

  async comIndiceOuSem(filtros, ler) {
    try {
      return await ler(filtros, false);
    } catch (error) {
      if (!faltaIndice(error) || !pedeForaDaLixeira(filtros)) throw error;
      this.logger.warn?.('produtos_fora_do_app_sem_indice', { colecao: 'Products', campos: filtros.map(([campo]) => campo) });
      return ler(semLixeira(filtros), true);
    }
  }

  async contarProdutos({ lojaId, filtros }) {
    return this.comIndiceOuSem(filtros, async (usados) => {
      const snapshot = await this.consulta(lojaId, usados).count().get();
      return Number(snapshot.data()?.count) || 0;
    });
  }

  async produtos({ lojaId, filtros, limite }) {
    return this.comIndiceOuSem(filtros, async (usados, semFiltroDaLixeira) => {
      const snapshot = await this.consulta(lojaId, usados).limit(limite).get();
      const lista = snapshot.docs.map((documento) => ({ id: documento.id, ...(documento.data() || {}) }));
      return semFiltroDaLixeira ? lista.filter((produto) => produto.isTrashed !== true) : lista;
    });
  }

  async produtosPorId({ lojaId, ids }) {
    if (!ids.length) return [];
    const colecao = this.produtosDaLoja(lojaId);
    const snapshots = await this.firestore.getAll(...ids.map((id) => colecao.doc(id)));
    return snapshots.filter((s) => s.exists).map((s) => ({ id: s.id, ...(s.data() || {}) }));
  }

  async documentoDaLoja({ lojaId, caminho }) {
    const snapshot = await this.firestore.doc(`estabelecimentos/${lojaId}/${caminho}`).get();
    return snapshot.exists ? (snapshot.data() || {}) : null;
  }

  // Chave do ERP da loja (Cola 71, item 3): documento da loja e IntegrationStatus/current.
  async configuracaoDoErp({ lojaId }) {
    return lerConfiguracaoDoErp(this.firestore, lojaId);
  }

  async ultimaLeitura({ lojaId }) {
    const snapshot = await this.firestore.collection('estabelecimentos').doc(lojaId).collection('IntegrationLogs')
      .orderBy('receivedAt', 'desc').limit(1).get();
    if (snapshot.empty) return null;
    const valor = snapshot.docs[0].data()?.receivedAt;
    if (valor && typeof valor.toDate === 'function') return valor.toDate();
    return valor instanceof Date ? valor : null;
  }
}
