import OpenAI from 'openai';
import { AiGateway } from '../../domain/ai/AiGateway.js';
import { AppError } from '../../domain/errors/AppError.js';

export class OpenAiCompatibleResponsesGateway extends AiGateway {
  constructor({
    apiKey,
    baseURL,
    model,
    temperature,
    provider,
    providerLabel,
    maxRetries,
    allowModelOverride = true,
    client,
  }) {
    super();
    this.model = model;
    this.temperature = temperature;
    this.provider = provider;
    this.providerLabel = providerLabel;
    this.allowModelOverride = allowModelOverride;
    this.client = client || (apiKey
      ? new OpenAI({ apiKey, baseURL, maxRetries })
      : null);
  }

  async generate({
    systemInstruction,
    userPrompt,
    responseFormat,
    content,
    model,
    temperature,
    maxOutputTokens,
  }) {
    if (!this.client) {
      throw new AppError(`A chave da ${this.providerLabel} nao foi configurada no backend.`, {
        statusCode: 503,
        code: `${this.provider}_not_configured`,
      });
    }

    const selectedModel = this.allowModelOverride && model ? model : this.model;

    try {
      const request = this.buildRequest({
        content,
        maxOutputTokens,
        selectedModel,
        systemInstruction,
        temperature,
        userPrompt,
      });
      const response = await this.client.responses.create(request);
      const text = extractOutputText(response);

      if (!text) {
        throw new AppError(`A ${this.providerLabel} nao retornou conteudo para esta solicitacao.`, {
          statusCode: 502,
          code: `${this.provider}_empty_response`,
        });
      }

      return {
        provider: this.provider,
        model: selectedModel,
        responseFormat,
        output: responseFormat === 'json' ? tryParseJson(text) : text,
        rawText: text,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError('Nao foi possivel consultar a IA agora.', {
        statusCode: 502,
        code: `${this.provider}_request_failed`,
        cause: error,
      });
    }
  }

  buildRequest({
    content,
    maxOutputTokens,
    selectedModel,
    systemInstruction,
    temperature,
    userPrompt,
  }) {
    const request = {
      model: selectedModel,
      temperature: temperature ?? this.temperature,
      input: [
        {
          role: 'system',
          content: systemInstruction,
        },
        {
          role: 'user',
          content: Array.isArray(content) && content.length ? content : userPrompt,
        },
      ],
    };

    if (maxOutputTokens) {
      request.max_output_tokens = maxOutputTokens;
    }

    return request;
  }
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks = [];

  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) {
        chunks.push(content.text);
      } else if (typeof content.text === 'string') {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
