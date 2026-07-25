import { OpenAiCompatibleResponsesGateway } from '../ai/OpenAiCompatibleResponsesGateway.js';

export class OpenAiResponsesGateway extends OpenAiCompatibleResponsesGateway {
  constructor({ apiKey, model, temperature, client }) {
    super({
      apiKey,
      model,
      temperature,
      client,
      provider: 'openai',
      providerLabel: 'OpenAI',
      maxRetries: 8,
      allowModelOverride: true,
    });
  }
}
