import { BugReportRepository } from '../../domain/bugReports/BugReportRepository.js';

export class FirestoreBugReportRepository extends BugReportRepository {
  constructor({ firestore }) {
    super();
    this.firestore = firestore;
  }

  collection(establishmentId) {
    return this.firestore
      .collection('estabelecimentos')
      .doc(establishmentId)
      .collection('BugReports');
  }

  async list(establishmentId, { from, to } = {}) {
    let query = this.collection(establishmentId).orderBy('createdAt', 'desc');
    if (from) query = query.where('createdAt', '>=', from);
    if (to) query = query.where('createdAt', '<=', to);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
  }

  async findById(establishmentId, reportId) {
    const doc = await this.collection(establishmentId).doc(reportId).get();
    if (!doc.exists) return null;
    return { ...doc.data(), id: doc.id };
  }

  async update(establishmentId, reportId, patch) {
    await this.collection(establishmentId).doc(reportId).update(patch);
  }
}
