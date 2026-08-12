import { Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';

export class ManageCoupons {
  constructor({ couponRepository, accessRepository, clock = () => new Date() }) {
    this.couponRepository = couponRepository;
    this.accessRepository = accessRepository;
    this.clock = clock;
  }

  async createCoupon({
    actorUid, code, description, termsText, firstPurchaseOnly, rules, discount,
    startAt, endAt, perCustomerLimit, totalUsageLimit, stackable,
  }) {
    const account = await this.requireEstablishment(actorUid);

    const normalizedCode = String(code || '').trim().toUpperCase();
    await this.assertCodeNotActive(normalizedCode, account.establishmentId);

    const coupon = {
      code: normalizedCode,
      description: String(description || '').trim(),
      termsText: termsText ? String(termsText).trim() : null,
      firstPurchaseOnly: Boolean(firstPurchaseOnly),
      active: true,
      startAt: Timestamp.fromDate(new Date(startAt)),
      endAt: Timestamp.fromDate(new Date(endAt)),
      establishmentIds: [account.establishmentId],
      rules: rules || [],
      discount,
      perCustomerLimit: perCustomerLimit ?? 1,
      totalUsageLimit: totalUsageLimit ?? null,
      usageCount: 0,
      stackable: Boolean(stackable),
      createdAt: Timestamp.fromDate(this.clock()),
    };

    return this.couponRepository.create(coupon);
  }

  async assertCodeNotActive(code, establishmentId) {
    const coupons = await this.couponRepository.list();
    const duplicateActive = coupons.some((coupon) =>
      coupon.code === code && coupon.active && coupon.establishmentIds?.includes(establishmentId));
    if (duplicateActive) {
      throw new AppError('Ja existe um cupom ativo com este codigo.', {
        statusCode: 409,
        code: 'coupon_code_already_exists',
      });
    }
  }

  async listCoupons({ actorUid }) {
    const account = await this.requireEstablishment(actorUid);
    const coupons = await this.couponRepository.list();
    return coupons.filter((coupon) => coupon.establishmentIds?.includes(account.establishmentId));
  }

  async updateCoupon({ actorUid, couponId, patch }) {
    const account = await this.requireEstablishment(actorUid);
    const coupon = await this.requireCoupon(couponId);
    this.assertOwnership(coupon, account.establishmentId);
    await this.couponRepository.update(couponId, patch);
  }

  async deactivateCoupon({ actorUid, couponId }) {
    const account = await this.requireEstablishment(actorUid);
    const coupon = await this.requireCoupon(couponId);
    this.assertOwnership(coupon, account.establishmentId);
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

  assertOwnership(coupon, establishmentId) {
    if (!coupon.establishmentIds?.includes(establishmentId)) {
      throw new AppError('Este cupom nao pertence ao seu estabelecimento.', {
        statusCode: 403,
        code: 'coupon_establishment_forbidden',
      });
    }
  }

  async requireEstablishment(actorUid) {
    const account = await this.accessRepository.findAccountByUid(actorUid);
    if (!account?.hasEstablishment) {
      throw new AppError('Conta sem estabelecimento vinculado.', {
        statusCode: 403,
        code: 'coupon_no_establishment',
      });
    }
    return account;
  }
}
