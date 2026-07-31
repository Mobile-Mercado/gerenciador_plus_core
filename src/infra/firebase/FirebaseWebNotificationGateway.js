import { getMessaging } from 'firebase-admin/messaging';
import { WebNotificationGateway } from '../../domain/notifications/WebNotificationGateway.js';

export class FirebaseWebNotificationGateway extends WebNotificationGateway {
  constructor({ app } = {}) {
    super();
    this.messaging = getMessaging(app);
  }

  async sendMulticast({ tokens, notification, data, webpush }) {
    const response = await this.messaging.sendEachForMulticast({
      tokens,
      data,
      webpush,
      ...(notification ? { notification } : {}),
    });

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      failures: response.responses
        .map((item, index) => ({
          token: tokens[index],
          success: item.success,
          code: item.error?.code || null,
        }))
        .filter((item) => !item.success),
    };
  }
}
