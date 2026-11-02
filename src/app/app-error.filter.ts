import {
  ArgumentsHost,
  Catch,
  HttpException,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { UniqueConstraintError, ValidationError } from "sequelize";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

@Catch()
export class AppErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    let appError: AppError;

    if (error instanceof AppError) appError = error;
    else if (error instanceof UniqueConstraintError)
      appError = AppError.conflict(
        "UNIQUE_CONSTRAINT",
        "A record with this value already exists.",
      );
    else if (error instanceof ValidationError)
      appError = AppError.unprocessable(
        "DATABASE_VALIDATION",
        "The submitted data is invalid.",
      );
    else if (error instanceof HttpException && error.getStatus() === 404)
      appError = AppError.notFound(
        `No route matches ${request.method} ${request.originalUrl}.`,
      );
    else if (error instanceof HttpException && error.getStatus() < 500)
      // Framework errors such as multer's 413 keep their client status.
      appError = new AppError(
        error.getStatus(),
        error.constructor.name
          .replace(/Exception$/, "")
          .replace(/([a-z])([A-Z])/g, "$1_$2")
          .toUpperCase() || "REQUEST_ERROR",
        error.message,
      );
    else {
      logger.error(
        { err: error, requestId: request.id },
        "Unhandled request error",
      );
      appError = new AppError(
        500,
        "INTERNAL_ERROR",
        "An unexpected error occurred.",
      );
    }

    response.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        fieldErrors: appError.fieldErrors,
        details: null,
      },
      requestId: request.id,
    });
  }
}
