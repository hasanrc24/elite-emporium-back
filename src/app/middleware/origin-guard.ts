import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import type { Request } from "express";

export function assertRequestOrigin(req: Request): void {
  const origin = req.get("origin");
  const fetchSite = req.get("sec-fetch-site");
  if (origin && origin !== env.PUBLIC_ORIGIN)
    throw AppError.forbidden("The request origin is not allowed.");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite))
    throw AppError.forbidden("Cross-site credential request rejected.");
  if (env.NODE_ENV === "production" && !origin) {
    const referer = req.get("referer");
    if (!referer?.startsWith(`${env.PUBLIC_ORIGIN}/`))
      throw AppError.forbidden("Request origin could not be verified.");
  }
}
