import { travadaNaLoja, travadasNaLoja } from '../../domain/catalogo/regraDaTrava.js';

// Leitura da trava para cada chamada que precisa dela, com cache em memoria de cinco
// minutos: as travadas da lista padrao (uma consulta, poucos documentos) e a liberacao de
// cada loja (um documento por loja). O Admin limpa o cache ao mudar a chave ou a liberacao,
// entao o prazo de cinco minutos so vale para outra instancia do Core.
const VALIDADE_MS = 5 * 60 * 1000;

export class TravasDeCategoria {
  constructor({ firestore, clock = () => Date.now(), validadeMs = VALIDADE_MS }) {
    this.firestore = firestore;
    this.clock = clock;
    this.validadeMs = validadeMs;
    this.padrao = null;
    this.lojas = new Map();
  }

  async travadasDoPadrao() {
    const agora = this.clock();
    if (this.padrao && this.padrao.ate > agora) return this.padrao.ids;
    const snapshot = await this.firestore.collection('categoriasProdutos').where('travada', '==', true).get();
    const ids = new Set(snapshot.docs.map((documento) => documento.id));
    this.padrao = { ids, ate: agora + this.validadeMs };
    return ids;
  }

  async liberadasDaLoja(lojaId) {
    if (!lojaId) return new Set();
    const agora = this.clock();
    const guardada = this.lojas.get(lojaId);
    if (guardada && guardada.ate > agora) return guardada.ids;
    const snapshot = await this.firestore.collection('liberacoesCategorias').doc(lojaId).get();
    const liberadas = snapshot.exists ? snapshot.data()?.liberadas : null;
    const ids = new Set(liberadas && typeof liberadas === 'object' ? Object.keys(liberadas) : []);
    this.lojas.set(lojaId, { ids, ate: agora + this.validadeMs });
    return ids;
  }

  async travadasNaLoja(lojaId) {
    const [travadas, liberadas] = await Promise.all([this.travadasDoPadrao(), this.liberadasDaLoja(lojaId)]);
    return new Set(travadasNaLoja({ travadas, liberadas }));
  }

  async estaTravada(lojaId, categoriaId) {
    const [travadas, liberadas] = await Promise.all([this.travadasDoPadrao(), this.liberadasDaLoja(lojaId)]);
    return travadaNaLoja(categoriaId, { travadas, liberadas });
  }

  esquecerPadrao() {
    this.padrao = null;
  }

  esquecerLoja(lojaId) {
    this.lojas.delete(lojaId);
  }
}
