export class CouponRepository {
  // Grava o Coupons/{id} e, na mesma escrita, o CuponsBastidores/{id} (objetivo e quem criou,
  // que o app do cliente nao le).
  async create(_coupon, _bastidores) {
    throw new Error('CouponRepository.create nao implementado.');
  }

  // Bastidores de cada cupom: Map couponId -> { objetivo, criadoPorUid, criadoPorNome, criadoEm }.
  async findBastidores(_couponIds) {
    throw new Error('CouponRepository.findBastidores nao implementado.');
  }

  // Objetivos que a loja criou: [{ id, nome }].
  async listObjetivosDaLoja(_establishmentId) {
    throw new Error('CouponRepository.listObjetivosDaLoja nao implementado.');
  }

  async list() {
    throw new Error('CouponRepository.list nao implementado.');
  }

  async findById(_couponId) {
    throw new Error('CouponRepository.findById nao implementado.');
  }

  // bastidores (opcional) e mesclado no CuponsBastidores/{id} na mesma escrita.
  async update(_couponId, _patch, _bastidores) {
    throw new Error('CouponRepository.update nao implementado.');
  }

  async delete(_couponId) {
    throw new Error('CouponRepository.delete nao implementado.');
  }

  // Clientes da loja ({ userId, nome, telefone }), para escolher o destinatario do cupom pessoal.
  async listClientesDaLoja(_establishmentId) {
    throw new Error('CouponRepository.listClientesDaLoja nao implementado.');
  }

  // Destinatario do cupom pessoal: o Users do cliente ({ userId, userAuthId }) quando ele ja comprou
  // na loja; senao, null.
  async findClienteDaLoja(_userId, _establishmentId) {
    throw new Error('CouponRepository.findClienteDaLoja nao implementado.');
  }
}
