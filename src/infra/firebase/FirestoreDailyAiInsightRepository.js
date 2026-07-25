import { FieldValue } from 'firebase-admin/firestore';
import { DailyAiInsightRepository } from '../../domain/ai/DailyAiInsightRepository.js';

const COLLECTION = 'AiDailyInsights';

export class FirestoreDailyAiInsightRepository extends DailyAiInsightRepository {
  constructor({ firestore }) {
    super();
    this.firestore = firestore;
  }

  async get({ establishmentId, dateKey }) {
    const snapshot = await this.reference(establishmentId, dateKey).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async tryAcquire({ establishmentId, dateKey, nowMs, leaseMs }) {
    const reference = this.reference(establishmentId, dateKey);

    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const data = snapshot.exists ? snapshot.data() : null;

      if (data?.status === 'ready' && data.output) return false;
      if (data?.status === 'generating' && Number(data.leaseUntilMs) > nowMs) return false;

      transaction.set(reference, {
        dateKey,
        status: 'generating',
        leaseUntilMs: nowMs + leaseMs,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });
  }

  async save({ establishmentId, dateKey, output, provider, model }) {
    await this.reference(establishmentId, dateKey).set({
      dateKey,
      status: 'ready',
      output,
      provider,
      model,
      generatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      leaseUntilMs: FieldValue.delete(),
      failedAt: FieldValue.delete(),
    }, { merge: true });
  }

  async markFailed({ establishmentId, dateKey }) {
    await this.reference(establishmentId, dateKey).set({
      status: 'failed',
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      leaseUntilMs: FieldValue.delete(),
    }, { merge: true });
  }

  reference(establishmentId, dateKey) {
    return this.firestore
      .collection('estabelecimentos')
      .doc(establishmentId)
      .collection(COLLECTION)
      .doc(dateKey);
  }
}
