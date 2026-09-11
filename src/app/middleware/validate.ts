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
  request[source] = result.data;
}
