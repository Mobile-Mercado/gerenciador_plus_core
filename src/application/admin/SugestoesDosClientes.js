import { AppError } from '../../domain/errors/AppError.js';

// Sugestoes que os clientes mandam pelo app (estabelecimentos/{loja}/Suggestions), de todas
// as lojas, para o Admin da plataforma. So leitura: nada aqui muda lida ou nao lida na loja.
//
// Pagina de 30, mais nova primeiro. Todas as lojas: consulta de grupo em Suggestions por
// createdAt (pede o indice de grupo de firestore.indexes.json). Uma loja: a colecao dela,
// com o indice automatico. Busca no texto: o Firestore nao procura trecho de texto, entao a
// busca varre no maximo 300 sugestoes por chamada a partir do cursor e devolve as que casam.
const TAMANHO_PAGINA = 30;
const MAX_VARRIDAS_NA_BUSCA = 300;
const LOTE_DA_BUSCA = 100;
const VALIDADE_NOMES_MS = 10 * 60 * 1000;

function chave(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function quando(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate().toISOString();
  if (valor instanceof Date) return valor.toISOString();
  return typeof valor === 'string' ? valor : null;
}

function indicePendente(error) {
  return error?.code === 9 || /requires (an|a COLLECTION_GROUP\w*) index/i.test(String(error?.message || ''));
}

export class SugestoesDosClientes {
  constructor({ firestore, clock = () => Date.now() }) {
    this.firestore = firestore;
    this.clock = clock;
    this.nomes = new Map();
  }

  // Nome das lojas da pagina, guardado por dez minutos: uma leitura por loja nova.
  async nomesDasLojas(ids) {
    const agora = this.clock();
    const faltam = ids.filter((id) => !(this.nomes.get(id)?.ate > agora));
    if (faltam.length) {
      const documentos = await this.firestore.getAll(...faltam.map((id) => this.firestore.collection('estabelecimentos').doc(id)));
      documentos.forEach((documento, indice) => {
        const data = documento.exists ? documento.data() || {} : {};
        this.nomes.set(faltam[indice], { nome: data.fantasyName || data.name || faltam[indice], ate: agora + VALIDADE_NOMES_MS });
      });
    }
    return new Map(ids.map((id) => [id, this.nomes.get(id)?.nome || id]));
  }

  async listar({ lojaId = null, busca = '', cursor = null } = {}) {
    const origem = lojaId
      ? this.firestore.collection('estabelecimentos').doc(lojaId).collection('Suggestions')
      : this.firestore.collectionGroup('Suggestions');
    const ordenada = origem.orderBy('createdAt', 'desc');
    let depoisDe = null;
    if (cursor) {
      const anterior = await this.firestore.doc(String(cursor)).get();
      if (anterior.exists) depoisDe = anterior;
    }

    const termo = chave(busca);
    const encontradas = [];
    let varridas = 0;
    let acabou = false;
    while (encontradas.length < TAMANHO_PAGINA && !acabou) {
      const lote = termo ? Math.min(LOTE_DA_BUSCA, MAX_VARRIDAS_NA_BUSCA - varridas) : TAMANHO_PAGINA;
      if (lote <= 0) break;
      const consulta = (depoisDe ? ordenada.startAfter(depoisDe) : ordenada).limit(lote);
      let snapshot;
      try {
        // eslint-disable-next-line no-await-in-loop
        snapshot = await consulta.get();
      } catch (error) {
        if (indicePendente(error)) {
          throw new AppError('A lista de todas as lojas precisa do índice de Suggestions (createdAt, grupo). Escolha uma loja ou crie o índice.', {
            statusCode: 503,
            code: 'sugestoes_indice_pendente',
          });
        }
        throw error;
      }
      varridas += snapshot.size;
      if (snapshot.size < lote) acabou = true;
      for (const documento of snapshot.docs) {
        depoisDe = documento;
        if (!termo || chave(documento.data()?.text).includes(termo)) encontradas.push(documento);
        if (encontradas.length >= TAMANHO_PAGINA) break;
      }
      if (!termo) break;
    }

    const lojas = [...new Set(encontradas.map((documento) => documento.ref.parent.parent?.id).filter(Boolean))];
    const nomes = await this.nomesDasLojas(lojas);
    return {
      itens: encontradas.map((documento) => {
        const data = documento.data() || {};
        const loja = documento.ref.parent.parent?.id || '';
        return {
          id: documento.id,
          lojaId: loja,
          nomeLoja: nomes.get(loja) || loja,
          criadaEm: quando(data.createdAt),
          texto: data.text || '',
          assunto: data.subject || 'other',
          userName: data.userName || null,
          userPhone: data.userPhone || null,
          userEmail: data.userEmail || null,
          platform: data.platform || null,
          appVersion: data.appVersion || null,
          lida: data.read === true,
        };
      }),
      // Caminho da ultima sugestao lida: a proxima pagina comeca depois dela.
      proximo: acabou ? null : depoisDe?.ref?.path || null,
      varridas,
    };
  }
}
