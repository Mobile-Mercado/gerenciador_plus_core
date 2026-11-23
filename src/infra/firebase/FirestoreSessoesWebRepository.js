import { FieldValue } from 'firebase-admin/firestore';

// Item 5.10 "Acessos conectados" (plano construcao-acessos-conectados.md):
// estabelecimentos/{loja}/SessoesWeb/{sessaoId} (uid, nome, criadoEm, ultimoUso, navegador, sistema,
// retrato, ip, encerradaEm, encerradaPor, motivo) e estabelecimentos/{loja}/IpsNomeados/{ip}
// (nome, nomeadoPor, nomeadoEm). So o Core le e grava: as regras do banco nao tem match para essas
// colecoes (bloqueio geral) e o BFF de dados nao passa (ManagerDataAccessPolicy, SUBCOLECOES_SO_DO_CORE).
export const SESSOES_WEB = 'SessoesWeb';
export const IPS_NOMEADOS = 'IpsNomeados';
const LOTE = 400;

export class FirestoreSessoesWebRepository {
  constructor({ firestore, serverTimestamp = () => FieldValue.serverTimestamp() }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
  }

  loja(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(lojaId);
  }

  async lojaExiste(lojaId) {
    return (await this.loja(lojaId).get()).exists;
  }

  async ler({ lojaId, sessaoId }) {
    const lido = await this.loja(lojaId).collection(SESSOES_WEB).doc(sessaoId).get();
    return lido.exists ? { sessaoId: lido.id, ...lido.data() } : null;
  }

  async criar({ lojaId, sessaoId, dados }) {
    await this.loja(lojaId).collection(SESSOES_WEB).doc(sessaoId).create({
      ...dados, criadoEm: this.serverTimestamp(), encerradaEm: null, encerradaPor: null, motivo: null,
    });
  }

  async atualizar({ lojaId, sessaoId, campos }) {
    await this.loja(lojaId).collection(SESSOES_WEB).doc(sessaoId).update(campos);
  }

  // Sessoes que nao foram encerradas (a tela do Admin so mostra estas).
  async listarAtivas({ lojaId }) {
    const lidos = await this.loja(lojaId).collection(SESSOES_WEB).where('encerradaEm', '==', null).get();
    return lidos.docs.map((doc) => ({ sessaoId: doc.id, ...doc.data() }));
  }

  async listarIpsNomeados({ lojaId }) {
    const lidos = await this.loja(lojaId).collection(IPS_NOMEADOS).get();
    return lidos.docs.map((doc) => ({ ip: doc.id, ...doc.data() }));
  }

  async nomearIp({ lojaId, ip, nome, adminUid }) {
    const ref = this.loja(lojaId).collection(IPS_NOMEADOS).doc(ip);
    if (!nome) {
      await ref.delete();
      return;
    }
    await ref.set({ nome, nomeadoPor: adminUid, nomeadoEm: this.serverTimestamp() });
  }

  // Encerra as sessoes indicadas (em lotes), gravando quem, quando e o motivo. Devolve quantas.
  async encerrar({ lojaId, sessaoIds, adminUid, motivo }) {
    const colecao = this.loja(lojaId).collection(SESSOES_WEB);
    for (let i = 0; i < sessaoIds.length; i += LOTE) {
      const lote = this.firestore.batch();
      sessaoIds.slice(i, i + LOTE).forEach((sessaoId) => {
        lote.update(colecao.doc(sessaoId), { encerradaEm: this.serverTimestamp(), encerradaPor: adminUid, motivo });
      });
      // eslint-disable-next-line no-await-in-loop
      await lote.commit();
    }
    return sessaoIds.length;
  }
}
