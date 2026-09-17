import { AppError } from '../../domain/errors/AppError.js';
import { EstablishmentAccessRepository } from '../../domain/auth/EstablishmentAccessRepository.js';

// Dono da loja: manda em tudo, sem grupo.
const OWNER_PERMISSIONS = { isAdmin: true, groupId: null, keys: [] };

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

  // Duas vias: funcionario com claim adminOf (AdminUsers + PermissionGroups) ou o
  // dono, pelo documento em Users. Sem AdminUsers para a claim, cai na via do dono,
  // que e o comportamento de hoje.
  async findAccountByClaims({ uid, adminOf, groupId } = {}) {
    if (!uid) return null;
    if (adminOf) {
      const admin = await this.findAdminAccount({ uid, adminOf, groupId });
      if (admin) return admin;
    }
    const account = await this.findAccountByUid(uid);
    return account ? { ...account, permissions: { ...OWNER_PERMISSIONS } } : null;
  }

  async findAdminAccount({ uid, adminOf, groupId }) {
    const establishmentReference = this.firestore.collection('estabelecimentos').doc(adminOf);
    const adminSnapshot = await establishmentReference.collection('AdminUsers').doc(uid).get();
    if (!adminSnapshot.exists) return null;

    const adminData = adminSnapshot.data() || {};
    if (adminData.active === false) {
      throw new AppError('Esta conta de funcionario esta desativada.', {
        statusCode: 403,
        code: 'admin_user_disabled',
      });
    }

    const [groupSnapshot, establishmentSnapshot] = await Promise.all([
      groupId
        ? establishmentReference.collection('PermissionGroups').doc(groupId).get()
        : Promise.resolve(null),
      establishmentReference.get(),
    ]);
    const groupData = groupSnapshot?.exists ? groupSnapshot.data() : null;
    const nome = [adminData.firstName, adminData.lastName].filter(Boolean).join(' ');

    return {
      uid,
      userId: uid,
      establishmentId: adminOf,
      userDocument: {
        id: uid,
        name: nome || null,
        nome: nome || null,
        email: adminData.email || null,
        image: null,
        userType: null,
      },
      establishmentDocument: establishmentSnapshot.exists
        ? sessionEstablishment(establishmentSnapshot.id, establishmentSnapshot.data())
        : null,
      hasEstablishment: establishmentSnapshot.exists,
      permissions: {
        isAdmin: groupData?.isAdmin === true,
        groupId: groupId || null,
        keys: Array.isArray(groupData?.permissions) ? groupData.permissions : [],
      },
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
