import { FieldValue } from 'firebase-admin/firestore';
import { IntegradorDaLojaRepository } from '../../domain/integrador/IntegradorDaLojaRepository.js';

export const INTEGRADOR_DA_LOJA = 'IntegradorDaLoja';
export const DOCUMENTO_ATUAL = 'atual';
// Sinal de vida do integrador (gravado pela funcao saveIntegrationHeartbeat do mobile_firebase_api).
export const INTEGRATION_STATUS = 'IntegrationStatus';
export const STATUS_ATUAL = 'current';

// Cola 65, item 4.11: o Admin da plataforma libera a troca do computador do integrador. So grava
// trocaLiberadaEm e trocaLiberadaPor (merge): maquina, registradoEm e ultimoUsoEm ficam como estao,
// e a funcao do integrador (outro repositorio) registra o proximo computador e volta
// trocaLiberadaEm a null.
export class FirestoreIntegradorDaLojaRepository extends IntegradorDaLojaRepository {
  constructor({ firestore, serverTimestamp = () => FieldValue.serverTimestamp() }) {
    super();
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
  }

  async liberarTroca({ lojaId, adminUid }) {
    const loja = this.firestore.collection('estabelecimentos').doc(lojaId);
    const registro = loja.collection(INTEGRADOR_DA_LOJA).doc(DOCUMENTO_ATUAL);
    return this.firestore.runTransaction(async (transacao) => {
      const [lojaLida, registroLido] = [await transacao.get(loja), await transacao.get(registro)];
      if (!lojaLida.exists) return { lojaExiste: false, computadorRegistrado: false };
      const maquina = registroLido.exists ? registroLido.data()?.maquina : null;
      // Cola 70, item 3: liberada a troca, ninguem esta mais bloqueado; a ultima tentativa recusada
      // sai junto (decisao anotada no relatorio). Quando o novo computador assume, a funcao do
      // integrador troca o documento inteiro e ela tambem nao volta.
      transacao.set(registro, {
        trocaLiberadaEm: this.serverTimestamp(),
        trocaLiberadaPor: adminUid,
        tentativaRecusada: FieldValue.delete(),
      }, { merge: true });
      return { lojaExiste: true, computadorRegistrado: typeof maquina === 'string' && maquina.length > 0 };
    });
  }

  // Cola 70: leitura do card "Computador do integrador" no Admin (so leitura, tres documentos).
  async lerComputador({ lojaId }) {
    const loja = this.firestore.collection('estabelecimentos').doc(lojaId);
    const [lojaLida, registro, status] = await Promise.all([
      loja.get(),
      loja.collection(INTEGRADOR_DA_LOJA).doc(DOCUMENTO_ATUAL).get(),
      loja.collection(INTEGRATION_STATUS).doc(STATUS_ATUAL).get(),
    ]);
    if (!lojaLida.exists) return { lojaExiste: false, registro: null, status: null };
    return {
      lojaExiste: true,
      registro: registro.exists ? registro.data() : null,
      status: status.exists ? status.data() : null,
    };
  }
}
