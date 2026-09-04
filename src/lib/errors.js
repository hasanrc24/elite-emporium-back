export class AppError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, string[]> | null} [fieldErrors] */
  constructor(status, code, message, fieldErrors = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  static badRequest(code, message, fields = null) { return new AppError(400, code, message, fields); }
  static unauthorized(code = 'UNAUTHENTICATED', message = 'Authentication is required.') { return new AppError(401, code, message); }
  static forbidden(message = 'You do not have permission to perform this action.') { return new AppError(403, 'FORBIDDEN', message); }
  static notFound(message = 'The requested resource was not found.') { return new AppError(404, 'NOT_FOUND', message); }
  static conflict(code, message) { return new AppError(409, code, message); }
  static tooManyRequests(code, message) { return new AppError(429, code, message); }
  static unprocessable(code, message, fields = null) { return new AppError(422, code, message, fields); }
}
