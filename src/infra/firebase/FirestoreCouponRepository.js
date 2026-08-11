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
}
