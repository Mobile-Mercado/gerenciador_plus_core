import { EstablishmentAccessRepository } from '../../domain/auth/EstablishmentAccessRepository.js';

export class FirestoreEstablishmentAccessRepository extends EstablishmentAccessRepository {
  constructor({ firestore }) {
    super();
    this.firestore = firestore;
  }

  async userCanAccess({ uid, establishmentId }) {
    if (!uid || !establishmentId) return false;

    const snapshot = await this.firestore
      .collection('Users')
      .where('userAuthId', '==', uid)
      .limit(10)
      .get();

    return snapshot.docs.some((document) => {
      const data = document.data();
      return document.id === establishmentId || data.id === establishmentId;
    });
  }
}
