import { AppError } from "../../lib/errors.js";
import type { Request } from "express";
import type { ZodType } from "zod";

export type RequestSource = "body" | "query" | "params";

export function validateRequest(
  request: Request,
  schema: ZodType,
  source: RequestSource = "body",
): void {
  const result = schema.safeParse(request[source]);
  if (!result.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "_form";
      fieldErrors[key] ||= [];
      fieldErrors[key].push(issue.message);
    }
    throw AppError.unprocessable(
      "VALIDATION_ERROR",
      "Check the highlighted fields.",
      fieldErrors,
    );
  }
  // Express 5 exposes req.query as a getter-only prototype property, so plain
  // assignment throws; shadow it with an own property holding the parsed data.
  Object.defineProperty(request, source, {
    value: result.data,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
