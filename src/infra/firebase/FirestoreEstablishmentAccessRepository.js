import { AppError } from '../../domain/errors/AppError.js';
import { EstablishmentAccessRepository } from '../../domain/auth/EstablishmentAccessRepository.js';
import { chavesDoGrupo } from '../../application/auth/chavesDoGrupo.js';

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

    // Dono so da loja que aponta para ele (13/10/2026): a loja do campo id so vale quando o
    // userReference dela e este mesmo documento de Users. Sem isso, qualquer conta que gravasse
    // no proprio Users o id de outra loja viraria dona dela.
    let establishmentSnapshot = await this.firestore
      .collection('estabelecimentos')
      .doc(establishmentId)
      .get();
    if (!lojaApontaPara(establishmentSnapshot, userSnapshot.ref)) {
      // Loja do cadastro pelo servidor: Users/{uid}.id e o proprio uid, como o app gerenciador
      // espera, e a loja e achada por userReference = Users/{uid}.
      const porReferencia = await this.firestore
        .collection('estabelecimentos')
        .where('userReference', '==', userSnapshot.ref)
        .limit(1)
        .get();
      establishmentSnapshot = porReferencia.empty ? null : porReferencia.docs[0];
    }
    const temLoja = Boolean(establishmentSnapshot?.exists);

    return {
      uid,
      userId: userSnapshot.id,
      establishmentId: temLoja ? establishmentSnapshot.id : establishmentId,
      userDocument: {
        id: userSnapshot.id,
        name: userData.name || null,
        nome: userData.nome || null,
        email: userData.email || null,
        image: userData.image || null,
        userType: userData.userType || null,
      },
      establishmentDocument: temLoja
        ? sessionEstablishment(establishmentSnapshot.id, establishmentSnapshot.data())
        : null,
      hasEstablishment: temLoja,
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
        // Grupo antigo ganha, so na leitura, a chave nova cuja tela ele ja via na web antiga
        // (RP-62, E.8): vale para a sessao e para as barreiras do Core.
        keys: groupData ? chavesDoGrupo(groupData) : [],
      },
    };
  }

  async userCanAccess({ uid, establishmentId }) {
    if (!uid || !establishmentId) return false;

    // Mesma regra do dono: so a loja cujo userReference e o Users da conta.
    const account = await this.findAccountByUid(uid);
    return account?.hasEstablishment === true && account.establishmentId === establishmentId;
  }
}

// A loja aponta para este Users quando userReference e o mesmo documento (mesmo caminho).
function lojaApontaPara(lojaSnapshot, usuarioRef) {
  if (!lojaSnapshot?.exists) return false;
  const referencia = lojaSnapshot.data()?.userReference;
  return Boolean(referencia?.path) && referencia.path === usuarioRef?.path;
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
    // Pedido de loja do cadastro novo. Loja antiga nao tem status e segue como hoje.
    status: data.status || null,
    motivoRecusa: data.status === 'recusada' ? data.motivoRecusa || null : null,
  };
}
