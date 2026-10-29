import { Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';

export const TIPO_TODOS = 'todos';
export const TIPO_CLIENTE = 'cliente';
const LIMITE_DA_BUSCA = 20;

// Objetivo do cupom (RP-62, D.1): os cinco padrao valem para toda loja e a loja pode ter os dela
// (ObjetivosDeCupom). O objetivo nao vai no Coupons/{id}, que o app do cliente le
// (checkout_confirmation_controller.dart): fica em CuponsBastidores/{couponId}, que so o Core le.
export const OBJETIVOS_PADRAO = Object.freeze([
  'Atrair clientes novos',
  'Trazer de volta quem sumiu',
  'Aumentar o valor da compra',
  'Vender produto parado',
  'Data comemorativa',
]);

// Regra 3 (RP-62, D.3): o cupom precisa de pelo menos uma regra (primeiro pedido, valor minimo,
// faixa de quantidade ou frete) ou do texto das regras da promocao. A duracao nao conta.
const TIPOS_DE_REGRA = new Set(['minValue', 'quantityRange', 'freight']);
export const MENSAGEM_CUPOM_SEM_REGRA = 'Marque pelo menos uma regra acima ou escreva as regras da promoção.';

export function cupomTemRegra({ firstPurchaseOnly, rules, termsText } = {}) {
  return firstPurchaseOnly === true
    || (Array.isArray(rules) && rules.some((rule) => TIPOS_DE_REGRA.has(rule?.type)))
    || String(termsText || '').trim().length > 0;
}

function assertCupomTemRegra(cupom) {
  if (cupomTemRegra(cupom)) return;
  throw new AppError(MENSAGEM_CUPOM_SEM_REGRA, { statusCode: 400, code: 'cupom_sem_regra' });
}

// O que a web recebe de cada cupom: o documento do Coupons mais o que esta nos bastidores.
export function cupomComBastidores(coupon, bastidores = null) {
  const nome = String(bastidores?.criadoPorNome || '').trim();
  return {
    ...coupon,
    objetivo: bastidores?.objetivo || null,
    // Cupom sem o dado (de antes da RP-62) sai sem "Criado por".
    criadoPor: nome ? { nome } : null,
    criadoEm: emIso(bastidores?.criadoEm),
  };
}

function emIso(valor) {
  if (!valor) return null;
  const segundos = valor.seconds ?? valor._seconds;
  const data = typeof valor.toDate === 'function' ? valor.toDate()
    : Number.isFinite(segundos) ? new Date(segundos * 1000)
      : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

function semAcento(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// "(27) *****-5432": so o DDD e os 4 ultimos digitos. Sem telefone, null.
export function telefoneMascarado(telefone) {
  let digitos = String(telefone || '').replace(/\D/g, '');
  if (digitos.length > 11 && digitos.startsWith('55')) digitos = digitos.slice(2);
  if (digitos.length < 8) return null;
  const ddd = digitos.length >= 10 ? digitos.slice(0, 2) : null;
  const resto = ddd ? digitos.slice(2) : digitos;
  return `${ddd ? `(${ddd}) ` : ''}${'*'.repeat(Math.max(resto.length - 4, 0))}-${resto.slice(-4)}`;
}

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
    tipo = null, objetivo, actorNome = null,
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

    assertCupomTemRegra({ firstPurchaseOnly, rules, termsText });

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

    // Quem criou e quando (RP-62, D.4): gravado so ao criar; editar mescla so o objetivo.
    const bastidores = {
      objetivo: String(objetivo || '').trim(),
      criadoPorUid: actorUid || null,
      criadoPorNome: String(actorNome || '').trim() || null,
      criadoEm: coupon.createdAt,
    };
    const criado = await this.couponRepository.create(coupon, bastidores);
    return cupomComBastidores(criado, bastidores);
  }

  // Busca de clientes da loja na criacao do cupom pessoal (cola RP-14 A.2): nome, telefone
  // mascarado (so DDD e os 4 ultimos) e o id do Users. Busca por nome (sem acento) ou pelos
  // digitos do telefone; no maximo 20, por nome.
  async buscarClientes({ actorUid, establishmentId, busca = '' }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const termo = semAcento(busca);
    const digitos = String(busca || '').replace(/\D/g, '');
    const clientes = await this.couponRepository.listClientesDaLoja(account.establishmentId);
    return clientes
      .filter((cliente) => !termo || semAcento(cliente.nome).includes(termo)
        || (digitos.length >= 4 && String(cliente.telefone || '').replace(/\D/g, '').includes(digitos)))
      .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'))
      .slice(0, LIMITE_DA_BUSCA)
      .map((cliente) => ({ userId: cliente.userId, nome: cliente.nome || 'Cliente', telefone: telefoneMascarado(cliente.telefone) }));
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
    const daLoja = coupons.filter((coupon) => coupon.establishmentIds?.includes(account.establishmentId));
    const bastidores = await this.couponRepository.findBastidores(daLoja.map((coupon) => coupon.id));
    return daLoja.map((coupon) => cupomComBastidores(coupon, bastidores.get(coupon.id)));
  }

  async getCoupon({ actorUid, establishmentId, couponId }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const coupon = await this.requireCoupon(couponId);
    this.assertOwnership(coupon, account.establishmentId);
    const bastidores = await this.couponRepository.findBastidores([coupon.id]);
    return cupomComBastidores(coupon, bastidores.get(coupon.id));
  }

  // Chips do "Objetivo do cupom": os padrao e os da loja.
  async listObjetivos({ actorUid, establishmentId }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const daLoja = await this.couponRepository.listObjetivosDaLoja(account.establishmentId);
    return { padrao: [...OBJETIVOS_PADRAO], daLoja };
  }

  // "+ Novo objetivo" (RP-62, D.2): fica salvo na loja para os proximos cupons. Mesmo nome de um
  // que a loja ja tem (sem diferenca de acento e de maiuscula) devolve o que ja existe.
  async createObjetivo({ actorUid, establishmentId, nome }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const limpo = String(nome || '').trim();
    const existentes = await this.couponRepository.listObjetivosDaLoja(account.establishmentId);
    const igual = existentes.find((objetivo) => semAcento(objetivo.nome) === semAcento(limpo));
    if (igual) return igual;
    return this.couponRepository.createObjetivoDaLoja(account.establishmentId, {
      nome: limpo,
      criadoPorUid: actorUid || null,
      criadoEm: Timestamp.fromDate(this.clock()),
    });
  }

  async updateCoupon({ actorUid, establishmentId, couponId, patch }) {
    const account = await this.requireEstablishment(actorUid, establishmentId);
    const coupon = await this.requireCoupon(couponId);
    this.assertOwnership(coupon, account.establishmentId);

    // O objetivo vai para os bastidores, nunca para o Coupons/{id}.
    const { objetivo, ...normalizedPatch } = patch;
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
    // Regra 3 na edicao: quando o PATCH mexe nas regras, o cupom como fica precisa ter uma.
    if (['firstPurchaseOnly', 'rules', 'termsText'].some((campo) => campo in normalizedPatch)) {
      assertCupomTemRegra({ ...coupon, ...normalizedPatch });
    }
    if (normalizedPatch.startAt != null) {
      normalizedPatch.startAt = Timestamp.fromDate(new Date(normalizedPatch.startAt));
    }
    if (normalizedPatch.endAt != null) {
      normalizedPatch.endAt = Timestamp.fromDate(new Date(normalizedPatch.endAt));
    }

    const bastidores = objetivo === undefined ? null : { objetivo: String(objetivo).trim() };
    await this.couponRepository.update(couponId, normalizedPatch, bastidores);
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
