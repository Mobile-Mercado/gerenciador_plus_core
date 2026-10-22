import { CouponRepository } from '../../domain/coupons/CouponRepository.js';

export class FirestoreCouponRepository extends CouponRepository {
  constructor({ firestore }) {
    super();
    this.firestore = firestore;
  }

  get collection() {
    return this.firestore.collection('Coupons');
  }

  async create(coupon) {
    const docRef = await this.collection.add(coupon);
    return { id: docRef.id, ...coupon };
  }

  async list() {
    const snapshot = await this.collection.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async findById(couponId) {
    const doc = await this.collection.doc(couponId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }

  async update(couponId, patch) {
    await this.collection.doc(couponId).update(patch);
  }

  async delete(couponId) {
    await this.collection.doc(couponId).delete();
  }

  // Clientes da loja para escolher o destinatario do cupom pessoal: { userId, nome, telefone }.
  // Le o ResumoClientes da loja (16 blocos, functions/resumoClientes.js); loja sem o resumo gerado
  // cai nos pedidos dela. So clientes com id do Users (o cupom pessoal precisa dele).
  async listClientesDaLoja(establishmentId) {
    const loja = this.firestore.collection('estabelecimentos').doc(String(establishmentId));
    const blocos = await loja.collection('ResumoClientes').get();
    const porId = new Map();
    blocos.docs.forEach((bloco) => {
      Object.values(bloco.data()?.clientes || {}).forEach((cliente) => {
        if (cliente?.userId && !porId.has(cliente.userId)) {
          porId.set(cliente.userId, { userId: cliente.userId, nome: cliente.nome || '', telefone: cliente.telefone || '' });
        }
      });
    });
    if (blocos.empty) {
      const pedidos = await this.firestore.collection('PurchaseRequests').where('companyReference', '==', loja).get();
      pedidos.docs.forEach((pedido) => {
        const dados = pedido.data() || {};
        if (dados.clientId && !porId.has(dados.clientId)) {
          porId.set(dados.clientId, { userId: dados.clientId, nome: dados.clientName || '', telefone: dados.clientePhoneNumber || '' });
        }
      });
    }
    return [...porId.values()];
  }

  // O pedido guarda em clientId o id do Users do cliente (nao o uid): um pedido dele nesta loja
  // basta para ele ser cliente da loja.
  async findClienteDaLoja(userId, establishmentId) {
    const usuario = await this.firestore.collection('Users').doc(String(userId)).get();
    const userAuthId = usuario.exists ? usuario.data()?.userAuthId : null;
    if (!userAuthId) return null;
    const loja = this.firestore.collection('estabelecimentos').doc(String(establishmentId));
    const pedidos = await this.firestore.collection('PurchaseRequests')
      .where('clientId', '==', usuario.id).where('companyReference', '==', loja).limit(1).get();
    return pedidos.empty ? null : { userId: usuario.id, userAuthId };
  }
}
