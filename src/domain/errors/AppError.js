export class AppError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = 'AppError';
    this.statusCode = options.statusCode || 500;
    this.code = options.code || 'internal_error';
    this.details = options.details;
    this.cause = options.cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}
