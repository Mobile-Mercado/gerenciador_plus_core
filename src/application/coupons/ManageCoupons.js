import { AppError } from '../../domain/errors/AppError.js';

export class ManageCoupons {
  constructor({ couponRepository, adminAccessRepository, clock = () => new Date() }) {
    this.couponRepository = couponRepository;
    this.adminAccessRepository = adminAccessRepository;
    this.clock = clock;
  }

  async createCoupon({
    actorUid, code, description, establishmentIds, rules, discount,
    startAt, endAt, perCustomerLimit, totalUsageLimit, stackable,
  }) {
    await this.assertAdmin(actorUid);

    if (!Array.isArray(establishmentIds) || establishmentIds.length === 0) {
      throw new AppError('Selecione ao menos um estabelecimento.', {
        statusCode: 400,
        code: 'coupon_establishment_required',
      });
    }

    const coupon = {
      code: String(code || '').trim().toUpperCase(),
      description: String(description || '').trim(),
      active: true,
      startAt,
      endAt,
      establishmentIds,
      rules: rules || [],
      discount,
      perCustomerLimit: perCustomerLimit ?? 1,
      totalUsageLimit: totalUsageLimit ?? null,
      usageCount: 0,
      stackable: Boolean(stackable),
      createdAt: this.clock().toISOString(),
    };

    return this.couponRepository.create(coupon);
  }

  async listCoupons({ actorUid }) {
    await this.assertAdmin(actorUid);
    return this.couponRepository.list();
  }

  async updateCoupon({ actorUid, couponId, patch }) {
    await this.assertAdmin(actorUid);
    await this.requireCoupon(couponId);
    await this.couponRepository.update(couponId, patch);
  }

  async deactivateCoupon({ actorUid, couponId }) {
    await this.assertAdmin(actorUid);
    await this.requireCoupon(couponId);
    await this.couponRepository.update(couponId, { active: false });
  }

  async requireCoupon(couponId) {
    const coupon = await this.couponRepository.findById(couponId);
    if (!coupon) {
      throw new AppError('Cupom nao encontrado.', {
        statusCode: 404,
        code: 'coupon_not_found',
      });
    }
    return coupon;
  }

  async assertAdmin(actorUid) {
    const isAdmin = await this.adminAccessRepository.isAdmin(actorUid);
    if (!isAdmin) {
      throw new AppError('Esta conta nao possui acesso a gestao de cupons.', {
        statusCode: 403,
        code: 'coupon_admin_forbidden',
      });
    }
  }
}
