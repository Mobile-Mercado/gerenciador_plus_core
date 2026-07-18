import OpenAI from 'openai';
import { AiGateway } from '../../domain/ai/AiGateway.js';
import { AppError } from '../../domain/errors/AppError.js';

export class OpenAiResponsesGateway extends AiGateway {
  constructor({ apiKey, model, temperature }) {
    super();
    this.model = model;
    this.temperature = temperature;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
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
      throw new AppError('A chave da OpenAI nao foi configurada no backend.', {
        statusCode: 503,
        code: 'openai_not_configured',
      });
    }

    try {
      const request = {
        model: model || this.model,
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

      const response = await this.client.responses.create(request);

      const text = extractOutputText(response);

      if (!text) {
        throw new AppError('A OpenAI nao retornou conteudo para esta solicitacao.', {
          statusCode: 502,
          code: 'openai_empty_response',
        });
      }

      return {
        provider: 'openai',
        model: model || this.model,
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
        code: 'openai_request_failed',
        cause: error,
      });
    }
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
