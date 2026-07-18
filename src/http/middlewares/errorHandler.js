import { ZodError } from 'zod';
import { isProduction } from '../../config/env.js';
import { AppError } from '../../domain/errors/AppError.js';
import { logger } from '../../infra/logger/logger.js';

export function notFoundHandler(request, response, next) {
  next(
    new AppError('Rota nao encontrada.', {
      statusCode: 404,
      code: 'route_not_found',
    }),
  );
}

export function errorHandler(error, request, response, _next) {
  const normalized = normalizeError(error);

  logger.error(normalized.message, {
    code: normalized.code,
    method: request.method,
    path: request.originalUrl,
    statusCode: normalized.statusCode,
  });

  response.status(normalized.statusCode).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    },
  });
}

function normalizeError(error) {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: 'validation_error',
      message: 'Revise os dados enviados.',
      details: error.flatten(),
    };
  }

  return {
    statusCode: 500,
    code: 'internal_error',
    message: 'Erro interno no backend.',
    details: isProduction() ? undefined : error?.message,
  };
}
