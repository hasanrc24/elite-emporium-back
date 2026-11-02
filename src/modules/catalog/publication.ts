import { AppError } from "../../lib/errors.js";
import { money } from "../../lib/money.js";

const STOCK_POLICIES = ["deny", "allow_backorder", "preorder", "available"];

interface PublicationVariant {
  status?: string | null;
  active?: boolean | null;
  regularPrice?: string | number | null;
  stockPolicy?: string | null;
  preorderAvailableAt?: string | Date | null;
}

export interface PublicationInput {
  /** Target status; `scheduled` additionally needs a future `publishAt`. */
  status: string;
  publishAt?: string | Date | null;
  slug?: string | null;
  categoryId?: string | null;
  names: { en?: string | null; bn?: string | null };
  variants: PublicationVariant[];
  primaryImageCount: number;
  imageCount: number;
  minImages: number;
  /** True when a `size` variation attribute is configured for the product. */
  requiresSizeChart: boolean;
  sizeChartCount: number;
}

function add(errors: Record<string, string[]>, key: string, message: string) {
  (errors[key] ||= []).push(message);
}

/**
 * Field-level publication requirements (BE-CAT-001, BE-CAT-004). Returns null
 * when the product may be published or scheduled.
 */
export function publicationErrors(
  input: PublicationInput,
  now = new Date(),
): Record<string, string[]> | null {
  if (!["published", "scheduled"].includes(input.status)) return null;
  const errors: Record<string, string[]> = {};
  if (!input.slug?.trim()) add(errors, "slug", "Enter a URL slug.");
  if (!input.names.en?.trim())
    add(errors, "translations.en.name", "Enter the English name.");
  if (!input.names.bn?.trim())
    add(errors, "translations.bn.name", "Enter the Bangla name.");
  if (!input.categoryId)
    add(errors, "categoryId", "Select a primary category.");
  const active = input.variants.filter(
    (variant) =>
      (variant.status || "active") === "active" && variant.active !== false,
  );
  if (!active.length)
    add(errors, "variants", "Keep at least one active variant.");
  else if (
    !active.some((variant) => money(variant.regularPrice).greaterThan(0))
  )
    add(errors, "variants", "An active variant needs a price above zero.");
  for (const variant of active) {
    const policy = variant.stockPolicy || "deny";
    if (!STOCK_POLICIES.includes(policy))
      add(errors, "variants", `Stock policy "${policy}" is not valid.`);
    if (policy === "preorder" && !variant.preorderAvailableAt)
      add(errors, "variants", "A preorder variant needs an availability date.");
  }
  if (input.primaryImageCount < 1)
    add(errors, "media", "Choose a primary image.");
  if (input.imageCount < Math.max(1, input.minImages))
    add(
      errors,
      "media",
      `Add at least ${Math.max(1, input.minImages)} product images.`,
    );
  if (input.requiresSizeChart && input.sizeChartCount < 1)
    add(
      errors,
      "sizeChartIds",
      "Assign a size chart to a product with a size variation.",
    );
  if (input.status === "scheduled") {
    const at = input.publishAt ? new Date(input.publishAt) : null;
    if (!at || Number.isNaN(at.getTime()) || at <= now)
      add(errors, "publishAt", "Choose a future publication time.");
  }
  return Object.keys(errors).length ? errors : null;
}

export function assertPublishable(input: PublicationInput, now = new Date()) {
  const errors = publicationErrors(input, now);
  if (!errors) return;
  const scheduleOnly = Object.keys(errors).join() === "publishAt";
  throw AppError.unprocessable(
    scheduleOnly ? "INVALID_PUBLISH_SCHEDULE" : "PUBLISH_REQUIREMENTS",
    scheduleOnly
      ? "Choose a future publication time for a scheduled product."
      : "Fix the highlighted fields before publishing this product.",
    errors,
  );
}
