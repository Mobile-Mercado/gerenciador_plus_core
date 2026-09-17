export class EstablishmentAccessRepository {
  async findAccountByUid() {
    throw new Error('EstablishmentAccessRepository.findAccountByUid precisa ser implementado.');
  }

  async findAccountByClaims() {
    throw new Error('EstablishmentAccessRepository.findAccountByClaims precisa ser implementado.');
  }

  async userCanAccess() {
    throw new Error('EstablishmentAccessRepository.userCanAccess precisa ser implementado.');
  }
}
