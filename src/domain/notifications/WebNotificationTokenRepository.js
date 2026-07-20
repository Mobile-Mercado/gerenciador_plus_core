export class WebNotificationTokenRepository {
  async listActiveByEstablishment() {
    throw new Error(
      'WebNotificationTokenRepository.listActiveByEstablishment precisa ser implementado.',
    );
  }

  async deactivate() {
    throw new Error('WebNotificationTokenRepository.deactivate precisa ser implementado.');
  }
}
