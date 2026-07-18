import { AppError } from '../../domain/errors/AppError.js';
import { getFirebaseAuth } from '../../infra/firebase/firebaseAdmin.js';

export function createFirebaseAuthMiddleware({ required }) {
  return async (request, _response, next) => {
    if (!required) {
      next();
      return;
    }

    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      next(
        new AppError('Login obrigatorio para usar a IA.', {
          statusCode: 401,
          code: 'auth_token_required',
        }),
      );
      return;
    }

    try {
      request.auth = await getFirebaseAuth().verifyIdToken(token);
      next();
    } catch (error) {
      next(
        new AppError('Sessao invalida ou expirada.', {
          statusCode: 401,
          code: 'auth_token_invalid',
          cause: error,
        }),
      );
    }
  };
}

function extractBearerToken(header) {
  if (!header) {
    return null;
  }

  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}
