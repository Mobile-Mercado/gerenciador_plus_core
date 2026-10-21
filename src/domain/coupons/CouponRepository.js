export class CouponRepository {
  async create(_coupon) {
    throw new Error('CouponRepository.create nao implementado.');
  }

  async list() {
    throw new Error('CouponRepository.list nao implementado.');
  }

  async findById(_couponId) {
    throw new Error('CouponRepository.findById nao implementado.');
  }

  async update(_couponId, _patch) {
    throw new Error('CouponRepository.update nao implementado.');
  }

  async delete(_couponId) {
    throw new Error('CouponRepository.delete nao implementado.');
  }

  // Destinatario do cupom pessoal: o Users do cliente ({ userId, userAuthId }) quando ele ja comprou
  // na loja; senao, null.
  async findClienteDaLoja(_userId, _establishmentId) {
    throw new Error('CouponRepository.findClienteDaLoja nao implementado.');
  }
}
