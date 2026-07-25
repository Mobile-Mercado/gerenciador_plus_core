import { AppError } from '../../domain/errors/AppError.js';

const CACHE_TIME_ZONE = 'America/Sao_Paulo';
const GENERATION_LEASE_MS = 60 * 1000;
const WAIT_ATTEMPTS = 12;
const WAIT_INTERVAL_MS = 1000;

export class GetDailyHomeOverviewUseCase {
  constructor({
    accessRepository,
    insightRepository,
    generateAiResponseUseCase,
    now = () => new Date(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) {
    this.accessRepository = accessRepository;
    this.insightRepository = insightRepository;
    this.generateAiResponseUseCase = generateAiResponseUseCase;
    this.now = now;
    this.sleep = sleep;
  }

  async execute({ uid, establishmentId, context }) {
    if (!uid) {
      throw new AppError('Login obrigatorio para gerar o resumo diario.', {
        statusCode: 401,
        code: 'auth_token_required',
      });
    }

    const canAccess = await this.accessRepository.userCanAccess({ uid, establishmentId });
    if (!canAccess) {
      throw new AppError('Voce nao pode acessar os dados deste estabelecimento.', {
        statusCode: 403,
        code: 'establishment_access_denied',
      });
    }

    const dateKey = dateKeyInTimeZone(this.now(), CACHE_TIME_ZONE);
    const cached = await this.readReady(establishmentId, dateKey);
    if (cached) return cachedResponse(cached, dateKey, true);

    const nowMs = this.now().getTime();
    const acquired = await this.insightRepository.tryAcquire({
      establishmentId,
      dateKey,
      nowMs,
      leaseMs: GENERATION_LEASE_MS,
    });

    if (!acquired) {
      const generatedByAnotherRequest = await this.waitForReady(establishmentId, dateKey);
      if (generatedByAnotherRequest) {
        return cachedResponse(generatedByAnotherRequest, dateKey, true);
      }

      throw new AppError('O resumo diario ainda esta sendo preparado. Tente novamente em instantes.', {
        statusCode: 503,
        code: 'daily_overview_generating',
      });
    }

    try {
      const result = await this.generateAiResponseUseCase.execute({
        task: 'home_overview',
        responseFormat: 'json',
        maxOutputTokens: 900,
        prompt: 'Analise o retrato operacional atual da loja e gere o resumo, o insight e as prioridades da Home.',
        context,
      });
      assertValidOverview(result.output);

      await this.insightRepository.save({
        establishmentId,
        dateKey,
        output: result.output,
        provider: result.provider,
        model: result.model,
      });

      return {
        ...result,
        cache: { dateKey, hit: false },
      };
    } catch (error) {
      await this.insightRepository.markFailed({ establishmentId, dateKey });
      throw error;
    }
  }

  async readReady(establishmentId, dateKey) {
    const cached = await this.insightRepository.get({ establishmentId, dateKey });
    return cached?.status === 'ready' && cached.output ? cached : null;
  }

  async waitForReady(establishmentId, dateKey) {
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
      await this.sleep(WAIT_INTERVAL_MS);
      const cached = await this.readReady(establishmentId, dateKey);
      if (cached) return cached;
    }
    return null;
  }
}

function cachedResponse(cached, dateKey, hit) {
  return {
    provider: cached.provider || 'cache',
    model: cached.model || 'daily-cache',
    responseFormat: 'json',
    output: cached.output,
    cache: { dateKey, hit },
  };
}

function dateKeyInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function assertValidOverview(output) {
  const valid = output
    && typeof output === 'object'
    && typeof output.summary === 'string'
    && output.summary.trim()
    && output.insight
    && typeof output.insight === 'object'
    && typeof output.insight.message === 'string'
    && output.insight.message.trim();

  if (!valid) {
    throw new AppError('A IA retornou um resumo diario incompleto.', {
      statusCode: 502,
      code: 'daily_overview_invalid',
    });
  }
}
