import { GroqResponsesGateway } from '../groq/GroqResponsesGateway.js';
import { OpenAiResponsesGateway } from '../openai/OpenAiResponsesGateway.js';

export function createAiGateway(config) {
  if (config.AI_PROVIDER === 'groq') {
    return new GroqResponsesGateway({
      apiKey: config.GROQ_API_KEY,
      model: config.GROQ_MODEL,
      temperature: config.GROQ_TEMPERATURE,
    });
  }

  return new OpenAiResponsesGateway({
    apiKey: config.OPENAI_API_KEY,
    model: config.OPENAI_MODEL,
    temperature: config.OPENAI_TEMPERATURE,
  });
}
