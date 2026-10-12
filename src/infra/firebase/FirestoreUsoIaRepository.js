import { FieldValue } from 'firebase-admin/firestore';

// Uso da IA por loja: estabelecimentos/{loja}/UsoIa/{auto}, um documento por chamada.
export class FirestoreUsoIaRepository {
  constructor({ firestore }) {
    this.firestore = firestore;
  }

  async registrar(establishmentId, registro) {
    await this.firestore
      .collection('estabelecimentos').doc(establishmentId).collection('UsoIa')
      .add({ ...registro, em: FieldValue.serverTimestamp() });
  }
}
