import { UniqueConstraintError, ValidationError } from 'sequelize';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export function notFound(req, _res, next) {
  next(AppError.notFound(`No route matches ${req.method} ${req.originalUrl}.`));
}

export function errorHandler(error, req, res, _next) {
  let appError = error;
  if (error instanceof UniqueConstraintError) appError = AppError.conflict('UNIQUE_CONSTRAINT', 'A record with this value already exists.');
  if (error instanceof ValidationError) appError = AppError.unprocessable('DATABASE_VALIDATION', 'The submitted data is invalid.');
  if (!(appError instanceof AppError)) {
    logger.error({ err: error, requestId: req.id }, 'Unhandled request error');
    appError = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  }
  res.status(appError.status).json({
    error: { code: appError.code, message: appError.message, fieldErrors: appError.fieldErrors, details: null },
    requestId: req.id,
  });
}
