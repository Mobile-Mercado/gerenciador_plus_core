import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { WebNotificationTokenRepository } from '../../domain/notifications/WebNotificationTokenRepository.js';

const MAX_TOKENS_PER_ESTABLISHMENT = 100;

export class FirestoreWebNotificationTokenRepository extends WebNotificationTokenRepository {
  constructor({ firestore }) {
    super();
    this.firestore = firestore;
  }

  async upsert({ establishmentId, token, userAgent }) {
    const tokenId = createHash('sha256').update(token).digest('hex');
    const reference = this.firestore.collection('FcmTokens').doc(tokenId);
    const snapshot = await reference.get();
    await reference.set(
      {
        clientId: establishmentId,
        token,
        platform: 'web',
        active: true,
        userAgent: String(userAgent || '').slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
        lastSeen: FieldValue.serverTimestamp(),
        ...(snapshot.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
    return { id: tokenId };
  }

  async listActiveByEstablishment(establishmentId) {
    const snapshot = await this.firestore
      .collection('FcmTokens')
      .where('clientId', '==', establishmentId)
      .where('active', '==', true)
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
