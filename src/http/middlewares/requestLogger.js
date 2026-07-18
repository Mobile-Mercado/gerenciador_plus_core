import { logger } from '../../infra/logger/logger.js';

export function requestLogger(request, response, next) {
  const start = Date.now();

  response.on('finish', () => {
    logger.info('http_request', {
      method: request.method,
      path: request.originalUrl,
      statusCode: response.statusCode,
      durationMs: Date.now() - start,
    });
  });

  next();
}
