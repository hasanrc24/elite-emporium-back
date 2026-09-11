export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string[]> | null = null,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(
    code: string,
    message: string,
    fields: Record<string, string[]> | null = null,
  ) {
    return new AppError(400, code, message, fields);
  }
  static unauthorized(
    code: string = "UNAUTHENTICATED",
    message: string = "Authentication is required.",
  ) {
    return new AppError(401, code, message);
  }
  static forbidden(
    message: string = "You do not have permission to perform this action.",
  ) {
    return new AppError(403, "FORBIDDEN", message);
  }
  static notFound(message: string = "The requested resource was not found.") {
    return new AppError(404, "NOT_FOUND", message);
  }
  static conflict(code: string, message: string) {
    return new AppError(409, code, message);
  }
  static tooManyRequests(code: string, message: string) {
    return new AppError(429, code, message);
  }
  static unprocessable(
    code: string,
    message: string,
    fields: Record<string, string[]> | null = null,
  ) {
    return new AppError(422, code, message, fields);
  }
}
