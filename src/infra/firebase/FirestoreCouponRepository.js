import { CouponRepository } from '../../domain/coupons/CouponRepository.js';

export class FirestoreCouponRepository extends CouponRepository {
  constructor({ firestore }) {
    super();
    this.firestore = firestore;
  }

  get collection() {
    return this.firestore.collection('Coupons');
  }

  // Objetivo e quem criou ficam fora do Coupons/{id} (o app do cliente le esse documento). A
  // colecao fica fechada pela regra padrao do Firestore: so o Core (Admin SDK) le.
  get bastidores() {
    return this.firestore.collection('CuponsBastidores');
  }

  objetivosDaLoja(establishmentId) {
    return this.firestore.collection('estabelecimentos').doc(String(establishmentId)).collection('ObjetivosDeCupom');
  }

  async create(coupon, bastidores = null) {
    const docRef = this.collection.doc();
    const lote = this.firestore.batch();
    lote.set(docRef, coupon);
    if (bastidores) lote.set(this.bastidores.doc(docRef.id), bastidores);
    await lote.commit();
    return { id: docRef.id, ...coupon };
  }

  async findBastidores(couponIds = []) {
    const ids = [...new Set(couponIds.filter(Boolean).map(String))];
    if (ids.length === 0) return new Map();
    const docs = await this.firestore.getAll(...ids.map((id) => this.bastidores.doc(id)));
    return new Map(docs.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()]));
  }

  async listObjetivosDaLoja(establishmentId) {
    const snapshot = await this.objetivosDaLoja(establishmentId).get();
    return snapshot.docs
      .map((doc) => ({ id: doc.id, nome: String(doc.data()?.nome || '') }))
      .filter((objetivo) => objetivo.nome)
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  async createObjetivoDaLoja(establishmentId, objetivo) {
    const docRef = await this.objetivosDaLoja(establishmentId).add(objetivo);
    return { id: docRef.id, nome: objetivo.nome };
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

  async update(couponId, patch, bastidores = null) {
    const lote = this.firestore.batch();
    if (Object.keys(patch || {}).length > 0) lote.update(this.collection.doc(couponId), patch);
    if (bastidores) lote.set(this.bastidores.doc(couponId), bastidores, { merge: true });
    await lote.commit();
  }

  async delete(couponId) {
    const lote = this.firestore.batch();
    lote.delete(this.collection.doc(couponId));
    lote.delete(this.bastidores.doc(couponId));
    await lote.commit();
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
