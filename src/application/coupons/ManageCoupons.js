import { Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';

export const TIPO_TODOS = 'todos';
export const TIPO_CLIENTE = 'cliente';

export class ManageCoupons {
  constructor({ couponRepository, accessRepository, clock = () => new Date() }) {
    this.couponRepository = couponRepository;
    this.accessRepository = accessRepository;
    this.clock = clock;
  }

  // Dois tipos (contrato da versao 55, decisao do Thay de 21/10/2026):
  // - 'todos' (campanha): um codigo para muitos clientes, com limite por cliente;
  // - 'cliente' (pessoal): destinatario { userId (id do Users), userAuthId }, uso unico. O cliente
  //   e escolhido pela loja entre quem ja comprou nela; targetClientId fica igual ao userId, para o
  //   aplicarCupom de hoje. Depois de usado o cupom fica marcado (usadoEm, usadoNoPedido) e nunca e
  //   apagado: a marca e gravada pelo servidor do cupom (mobile_firebase_api).
  async createCoupon({
    actorUid, establishmentId, code, description, termsText, scopeName, firstPurchaseOnly, rules, discount,
    startAt, endAt, perCustomerLimit, totalUsageLimit, stackable, targetClientId = null, campaignId = null,
    tipo = null,
  }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const tipoDoCupom = tipo || (targetClientId ? TIPO_CLIENTE : TIPO_TODOS);
    if (tipoDoCupom === TIPO_TODOS && targetClientId) {
      throw new AppError('Cupom para todos não tem cliente escolhido.', { statusCode: 400, code: 'coupon_tipo_invalido' });
    }
    let destinatario = null;
    if (tipoDoCupom === TIPO_CLIENTE) {
      if (!targetClientId) {
        throw new AppError('Escolha o cliente do cupom.', { statusCode: 400, code: 'coupon_destinatario_obrigatorio' });
      }
      destinatario = await this.couponRepository.findClienteDaLoja(targetClientId, account.establishmentId);
      if (!destinatario) {
        throw new AppError('Este cliente ainda não comprou nesta loja.', { statusCode: 400, code: 'coupon_destinatario_invalido' });
      }
    }

    const normalizedCode = String(code || '').trim().toUpperCase();
    await this.assertCodeNotActive(normalizedCode, account.establishmentId);

    const coupon = {
      code: normalizedCode,
      description: String(description || '').trim(),
      termsText: termsText ? String(termsText).trim() : null,
      scopeName: scopeName ? String(scopeName).trim() : null,
      firstPurchaseOnly: Boolean(firstPurchaseOnly),
      active: true,
      startAt: Timestamp.fromDate(new Date(startAt)),
      // Sem data de fim: endAt null (o cupom vale ate ser desativado).
      endAt: endAt ? Timestamp.fromDate(new Date(endAt)) : null,
      establishmentIds: [account.establishmentId],
      rules: rules || [],
      // Frete gratis sem desconto nos produtos: discount null.
      discount: discount ?? null,
      perCustomerLimit: destinatario ? 1 : (perCustomerLimit ?? 1),
      totalUsageLimit: destinatario ? 1 : (totalUsageLimit ?? null),
      usageCount: 0,
      stackable: Boolean(stackable),
      tipo: tipoDoCupom,
      destinatario,
      // Cupom pessoal: so este cliente consegue aplicar (aplicarCupom confere).
      targetClientId: destinatario ? destinatario.userId : null,
      campaignId: campaignId || null,
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

  async listCoupons({ actorUid, establishmentId }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const coupons = await this.couponRepository.list();
    return coupons.filter((coupon) => coupon.establishmentIds?.includes(account.establishmentId));
  }

  async updateCoupon({ actorUid, establishmentId, couponId, patch }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const coupon = await this.requireCoupon(couponId);
    this.assertOwnership(coupon, account.establishmentId);

    const normalizedPatch = { ...patch };
    // Cupom pessoal e de uso unico: os limites nao mudam.
    if (coupon.tipo === TIPO_CLIENTE && ['perCustomerLimit', 'totalUsageLimit'].some((campo) => campo in normalizedPatch && normalizedPatch[campo] !== 1)) {
      throw new AppError('Cupom de um cliente vale uma vez só.', { statusCode: 400, code: 'coupon_pessoal_uso_unico' });
    }
    if (normalizedPatch.code != null) {
      const normalizedCode = String(normalizedPatch.code).trim().toUpperCase();
      if (normalizedCode !== coupon.code) {
        await this.assertCodeNotActive(normalizedCode, account.establishmentId);
      }
      normalizedPatch.code = normalizedCode;
    }
    if (normalizedPatch.startAt != null) {
      normalizedPatch.startAt = Timestamp.fromDate(new Date(normalizedPatch.startAt));
    }
    if (normalizedPatch.endAt != null) {
      normalizedPatch.endAt = Timestamp.fromDate(new Date(normalizedPatch.endAt));
    }

    await this.couponRepository.update(couponId, normalizedPatch);
  }

  async deactivateCoupon({ actorUid, establishmentId, couponId }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const coupon = await this.requireCoupon(couponId);
    this.assertOwnership(coupon, account.establishmentId);
    await this.couponRepository.update(couponId, { active: false });
  }

  async deleteCoupon({ actorUid, establishmentId, couponId }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const coupon = await this.requireCoupon(couponId);
    this.assertOwnership(coupon, account.establishmentId);

    if (coupon.usageCount > 0 || coupon.usadoEm) {
      throw new AppError('Cupom ja possui uso registrado; desative-o em vez de excluir.', {
        statusCode: 409,
        code: 'coupon_has_usage',
      });
    }

    await this.couponRepository.delete(couponId);
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

  // Loja da conta da requisicao (accountForRequest, que entende adminOf do funcionario e o Admin da
  // plataforma). Sem ela, cai na conta do dono pelo uid.
  async requireEstablishment(actorUid, establishmentId = null) {
    if (establishmentId) return { establishmentId, hasEstablishment: true };
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
