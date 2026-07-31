import { EstablishmentAccessRepository } from '../../domain/auth/EstablishmentAccessRepository.js';

export class FirestoreEstablishmentAccessRepository extends EstablishmentAccessRepository {
  constructor({ firestore }) {
    super();
    this.firestore = firestore;
  }

  async findAccountByUid(uid) {
    if (!uid) return null;

    const snapshot = await this.firestore
      .collection('Users')
      .where('userAuthId', '==', uid)
      .limit(2)
      .get();

    if (snapshot.empty) return null;

    const userSnapshot = snapshot.docs[0];
    const userData = userSnapshot.data() || {};
    const establishmentId = String(userData.id || userSnapshot.id || '').trim();
    if (!establishmentId) return null;

    const establishmentSnapshot = await this.firestore
      .collection('estabelecimentos')
      .doc(establishmentId)
      .get();

    return {
      uid,
      userId: userSnapshot.id,
      establishmentId,
      userDocument: {
        id: userSnapshot.id,
        name: userData.name || null,
        nome: userData.nome || null,
        email: userData.email || null,
        image: userData.image || null,
        userType: userData.userType || null,
      },
      establishmentDocument: establishmentSnapshot.exists
        ? sessionEstablishment(establishmentSnapshot.id, establishmentSnapshot.data())
        : null,
      hasEstablishment: establishmentSnapshot.exists,
    };
  }

  async userCanAccess({ uid, establishmentId }) {
    if (!uid || !establishmentId) return false;

    const account = await this.findAccountByUid(uid);
    return account?.establishmentId === establishmentId;
  }
}

function sessionEstablishment(id, data = {}) {
  return {
    id,
    name: data.name || null,
    fantasyName: data.fantasyName || null,
    corporateName: data.corporateName || null,
    coorporativeName: data.coorporativeName || null,
    image: data.image || data.imageUrl || null,
    userType: data.userType || null,
  };
}
