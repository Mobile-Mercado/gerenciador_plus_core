// Admin da plataforma: usersAdmin/{uid}.isAdmin == true. Nao confundir com o isAdmin das
// permissoes da loja, que quer dizer dono. Desde 12/10/2026 so as contas do Thay criam
// documento em usersAdmin (createUserAdmin do mobile_old_web_platform).
export class FirestorePlatformAdminRepository {
  constructor({ firestore }) {
    this.firestore = firestore;
  }

  async isPlatformAdmin(uid) {
    if (!uid) return false;
    const snapshot = await this.firestore.collection('usersAdmin').doc(uid).get();
    return snapshot.exists && snapshot.data()?.isAdmin === true;
  }
}
