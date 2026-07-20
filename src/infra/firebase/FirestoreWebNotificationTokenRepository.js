import { FieldValue } from 'firebase-admin/firestore';
import { WebNotificationTokenRepository } from '../../domain/notifications/WebNotificationTokenRepository.js';

const MAX_TOKENS_PER_ESTABLISHMENT = 100;

export class FirestoreWebNotificationTokenRepository extends WebNotificationTokenRepository {
  constructor({ firestore }) {
    super();
    this.firestore = firestore;
  }

  async listActiveByEstablishment(establishmentId) {
    const snapshot = await this.firestore
      .collection('FcmTokens')
      .where('clientId', '==', establishmentId)
      .limit(MAX_TOKENS_PER_ESTABLISHMENT)
      .get();

    return snapshot.docs
      .map((document) => ({
        id: document.id,
        token: String(document.data().token || document.id || '').trim(),
        active: document.data().active !== false,
      }))
      .filter((entry) => entry.active && entry.token);
  }

  async deactivate(tokenIds) {
    const uniqueIds = [...new Set(tokenIds.filter(Boolean))];
    if (!uniqueIds.length) return;

    const batch = this.firestore.batch();
    uniqueIds.forEach((tokenId) => {
      batch.set(
        this.firestore.collection('FcmTokens').doc(tokenId),
        {
          active: false,
          invalidatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
    await batch.commit();
  }
}
