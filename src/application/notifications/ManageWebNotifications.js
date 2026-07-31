import { AppError } from '../../domain/errors/AppError.js';

const MAX_TOKENS_PER_MESSAGE = 500;
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);
const ALLOWED_REDIRECT_PATHS = new Set([
  '/home',
  '/pedidos',
  '/mensagens',
  '/produtos',
  '/ajustes',
  '/implantacao',
]);

export class ManageWebNotifications {
  constructor({ tokenRepository, gateway, accessRepository, clock = () => new Date() }) {
    this.tokenRepository = tokenRepository;
    this.gateway = gateway;
    this.accessRepository = accessRepository;
    this.clock = clock;
  }

  async registerToken({ actorUid, token, userAgent }) {
    const safeToken = String(token || '').trim();
    if (safeToken.length < 20 || safeToken.length > 4096) {
      throw new AppError('Token de notificacao invalido.', {
        statusCode: 400,
        code: 'notification_token_invalid',
      });
    }

    const account = await this.accessRepository.findAccountByUid(actorUid);
    if (!account?.hasEstablishment) {
      throw new AppError('Conta sem estabelecimento ativo.', {
        statusCode: 403,
        code: 'notification_establishment_forbidden',
      });
    }

    await this.tokenRepository.upsert({
      establishmentId: account.establishmentId,
      token: safeToken,
      userAgent: sanitizeText(userAgent, 500),
    });
    const tokens = await this.tokenRepository.listActiveByEstablishment(account.establishmentId);
    return {
      establishmentId: account.establishmentId,
      enabled: true,
      activeTokens: tokens.length,
    };
  }

  async getStatus({ actorUid, establishmentId }) {
    await this.assertAccess({ actorUid, establishmentId });
    const tokens = await this.tokenRepository.listActiveByEstablishment(establishmentId);
    return {
      establishmentId,
      enabled: tokens.length > 0,
      activeTokens: tokens.length,
    };
  }

  async sendTest({ actorUid, establishmentId }) {
    await this.assertAccess({ actorUid, establishmentId });
    return this.sendSystemNotification({
      establishmentId,
      title: 'Notificacoes ativadas',
      body: 'Este navegador esta pronto para receber avisos do gerenciador.',
      url: '/ajustes',
      tag: 'web-notification-test',
      data: { type: 'notification_test' },
    });
  }

  async sendSystemNotification({
    establishmentId,
    title,
    body,
    url = '/home',
    tag = 'gerenciador-notification',
    data = {},
  }) {
    const safeEstablishmentId = sanitizeText(establishmentId, 120);
    if (!safeEstablishmentId) {
      throw new AppError('Estabelecimento obrigatorio para enviar notificacao.', {
        statusCode: 400,
        code: 'notification_establishment_required',
      });
    }

    const tokens = await this.tokenRepository.listActiveByEstablishment(safeEstablishmentId);
    if (!tokens.length) {
      return {
        establishmentId: safeEstablishmentId,
        activeTokens: 0,
        successCount: 0,
        failureCount: 0,
        invalidTokensDeactivated: 0,
      };
    }

    const safeTitle = sanitizeText(title, 100) || 'Gerenciador Mobile Mercado';
    const safeBody = sanitizeText(body, 240);
    const safeUrl = normalizeRedirectUrl(url);
    const safeTag = sanitizeText(tag, 100) || 'gerenciador-notification';
    const timestamp = this.clock().toISOString();
    const messageData = normalizeData({
      ...data,
      title: safeTitle,
      body: safeBody,
      url: safeUrl,
      tag: safeTag,
      establishmentId: safeEstablishmentId,
      timestamp,
    });

    let successCount = 0;
    let failureCount = 0;
    const invalidTokenIds = [];

    for (const chunk of chunkArray(tokens, MAX_TOKENS_PER_MESSAGE)) {
      const result = await this.gateway.sendMulticast({
        tokens: chunk.map((entry) => entry.token),
        data: messageData,
        webpush: {
          headers: {
            Urgency: 'high',
          },
          fcmOptions: { link: safeUrl },
        },
      });

      successCount += result.successCount;
      failureCount += result.failureCount;
      result.failures.forEach((failure) => {
        if (!INVALID_TOKEN_CODES.has(failure.code)) return;
        const entry = chunk.find((candidate) => candidate.token === failure.token);
        if (entry) invalidTokenIds.push(entry.id);
      });
    }

    await this.tokenRepository.deactivate(invalidTokenIds);

    return {
      establishmentId: safeEstablishmentId,
      activeTokens: tokens.length,
      successCount,
      failureCount,
      invalidTokensDeactivated: new Set(invalidTokenIds).size,
    };
  }

  async assertAccess({ actorUid, establishmentId }) {
    if (!actorUid) {
      throw new AppError('Login obrigatorio para gerenciar notificacoes.', {
        statusCode: 401,
        code: 'auth_token_required',
      });
    }

    const allowed = await this.accessRepository.userCanAccess({
      uid: actorUid,
      establishmentId,
    });
    if (!allowed) {
      throw new AppError('Voce nao pode gerenciar notificacoes deste estabelecimento.', {
        statusCode: 403,
        code: 'notification_establishment_forbidden',
      });
    }
  }
}

function sanitizeText(value, maxLength) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>"'&]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalizeRedirectUrl(value) {
  const url = String(value || '');
  if (!url.startsWith('/')) return '/home';
  const basePath = `/${url.split('/')[1]}`;
  return ALLOWED_REDIRECT_PATHS.has(basePath) ? url.slice(0, 500) : '/home';
}

function normalizeData(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .slice(0, 30)
      .map(([key, value]) => [sanitizeText(key, 80), sanitizeText(value, 500)]),
  );
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
