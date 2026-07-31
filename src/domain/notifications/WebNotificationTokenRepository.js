export class WebNotificationTokenRepository {
  async upsert() {
    throw new Error('WebNotificationTokenRepository.upsert precisa ser implementado.');
  }

  async listActiveByEstablishment() {
    throw new Error(
      'WebNotificationTokenRepository.listActiveByEstablishment precisa ser implementado.',
    );
  }

  async deactivate() {
    throw new Error('WebNotificationTokenRepository.deactivate precisa ser implementado.');
  }
}
