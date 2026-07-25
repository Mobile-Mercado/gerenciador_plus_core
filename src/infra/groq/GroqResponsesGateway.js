import { OpenAiCompatibleResponsesGateway } from '../ai/OpenAiCompatibleResponsesGateway.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export class GroqResponsesGateway extends OpenAiCompatibleResponsesGateway {
  constructor({ apiKey, model, temperature, client }) {
    super({
      apiKey,
      model,
      temperature,
      client,
      baseURL: GROQ_BASE_URL,
      provider: 'groq',
      providerLabel: 'Groq',
      maxRetries: 2,
      // O frontend ainda envia nomes de modelos OpenAI em algumas automacoes.
      allowModelOverride: false,
    });
  }
}
