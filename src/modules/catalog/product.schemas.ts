import { z } from "zod";

export const productSlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(180);
export const productMoneySchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const id = z.string().length(26);
const optionalId = id.nullable().optional();
const dateTime = z.iso.datetime().nullable().optional();

const productTranslation = z.object({
  name: z.string().trim().min(1).max(220),
  shortDescription: z.string().max(2_000).default(""),
  description: z.string().max(100_000).default(""),
  careText: z.string().max(20_000).nullable().optional(),
  materialText: z.string().max(20_000).nullable().optional(),
  seoTitle: z.string().trim().max(255).nullable().optional(),
  seoDescription: z.string().trim().max(500).nullable().optional(),
});
const translations = z.object({
  en: productTranslation,
  bn: productTranslation,
});
const dimensions = z
  .object({
    lengthCm: z.number().positive().max(100_000).nullable().optional(),
    widthCm: z.number().positive().max(100_000).nullable().optional(),
    heightCm: z.number().positive().max(100_000).nullable().optional(),
  })
  .nullable()
  .optional();
const variantFields = {
  sku: z.string().trim().min(1).max(100),
  barcode: z.string().trim().max(100).nullable().optional(),
  title: z.string().trim().min(1).max(180),
  attributes: z.record(z.string(), z.string()).default({}),
  attributeValueIds: z.array(id).max(50).default([]),
  regularPrice: productMoneySchema,
  salePrice: productMoneySchema.nullable().optional(),
  costPrice: productMoneySchema.nullable().optional(),
  saleStartsAt: dateTime,
  saleEndsAt: dateTime,
  stockPolicy: z.enum(["deny", "allow_backorder", "preorder", "available"]).default("deny"),
  preorderAvailableAt: dateTime,
  preorderMessage: z.string().trim().max(255).nullable().optional(),
  weightGrams: z.number().int().min(0).max(10_000_000).nullable().optional(),
  dimensions,
  status: z.enum(["active", "archived"]).default("active"),
  isDefault: z.boolean().default(false),
};

interface VariantValue {
  sku: string;
  regularPrice: string;
  salePrice?: string | null;
  saleStartsAt?: string | null;
  saleEndsAt?: string | null;
  stockPolicy: "deny" | "allow_backorder" | "preorder" | "available";
  preorderAvailableAt?: string | null;
  isDefault?: boolean;
  status: "active" | "archived";
}

function validateVariant(value: VariantValue, context: z.RefinementCtx) {
  if (
    value.salePrice != null &&
    Number(value.salePrice) >= Number(value.regularPrice)
  )
    context.addIssue({
      code: "custom",
      path: ["salePrice"],
      message: "Sale price must be lower than regular price.",
    });
  if (
    value.saleStartsAt &&
    value.saleEndsAt &&
    value.saleStartsAt >= value.saleEndsAt
  )
    context.addIssue({
      code: "custom",
      path: ["saleEndsAt"],
      message: "Sale end must be after sale start.",
    });
  if (value.stockPolicy === "preorder" && !value.preorderAvailableAt)
    context.addIssue({
      code: "custom",
      path: ["preorderAvailableAt"],
      message: "Preorder availability is required for preorder stock policy.",
    });
}

const createVariantSchema = z
  .object({
    ...variantFields,
    stock: z.number().int().min(0),
    lowStockThreshold: z.number().int().min(0).default(3),
  })
  .superRefine(validateVariant);

const updateVariantSchema = z
  .object({
    ...variantFields,
    id: id.optional(),
    clientKey: z.string().trim().min(1).max(100).optional(),
    version: z.number().int().positive().optional(),
    initialStock: z.number().int().min(0).default(0),
    lowStockThreshold: z.number().int().min(0).default(3),
  })
  .superRefine((value, context) => {
    validateVariant(value, context);
    if (value.id && !value.version)
      context.addIssue({
        code: "custom",
        path: ["version"],
        message:
          "Variant version is required when editing an existing variant.",
      });
    if (!value.id && !value.clientKey)
      context.addIssue({
        code: "custom",
        path: ["clientKey"],
        message: "A stable client key is required for a new variant.",
      });
  });

const mediaFields = {
  mediaId: id,
  role: z
    .enum(["primary", "gallery", "swatch", "size_chart"])
    .default("gallery"),
  displayOrder: z.number().int().min(0).optional(),
  altEn: z.string().trim().max(500).nullable().optional(),
  altBn: z.string().trim().max(500).nullable().optional(),
};
const createMediaSchema = z.object({
  ...mediaFields,
  variantSku: z.string().trim().max(100).nullable().optional(),
});
const updateMediaSchema = z.object({
  ...mediaFields,
  variantKey: z.string().trim().max(100).nullable().optional(),
});
const attributeSchema = z.object({
  attributeId: id,
  variation: z.boolean().default(false),
  visible: z.boolean().default(true),
  displayOrder: z.number().int().min(0).optional(),
});
const shippingProfileSchema = z
  .object({
    requiresShipping: z.boolean().default(true),
    freeShipping: z.boolean().default(false),
    shippingClass: z.string().trim().max(80).nullable().optional(),
  })
  .nullable()
  .optional();

interface ProductValidationValue {
  variants: Array<VariantValue & { id?: string; clientKey?: string }>;
  media: Array<{ role: string }>;
  status: string;
  publishAt?: string | null;
}

function validateProduct(
  value: ProductValidationValue,
  context: z.RefinementCtx,
) {
  const skus = value.variants.map((item) => item.sku.toLocaleLowerCase("en"));
  if (new Set(skus).size !== skus.length)
    context.addIssue({
      code: "custom",
      path: ["variants"],
      message: "Variant SKUs must be unique.",
    });
  const defaults = value.variants.filter(
    (item) => item.isDefault && item.status === "active",
  );
  if (defaults.length > 1)
    context.addIssue({
      code: "custom",
      path: ["variants"],
      message: "Only one active variant can be the default.",
    });
  if (value.media.filter((item) => item.role === "primary").length > 1)
    context.addIssue({
      code: "custom",
      path: ["media"],
      message: "Only one product image can be primary.",
    });
  if (value.status === "scheduled" && !value.publishAt)
    context.addIssue({
      code: "custom",
      path: ["publishAt"],
      message: "Publication time is required for a scheduled product.",
    });
}

const productFields = {
  slug: productSlugSchema,
  categoryId: optionalId,
  categoryIds: z.array(id).max(50).default([]),
  collectionIds: z.array(id).max(50).default([]),
  brandId: optionalId,
  type: z.enum(["simple", "variable"]).default("simple"),
  status: z.enum(["draft", "scheduled", "published"]).default("draft"),
  publishAt: dateTime,
  featured: z.boolean().default(false),
  visibility: z
    .enum(["catalog_search", "catalog", "search", "hidden"])
    .default("catalog_search"),
  taxClass: z.string().trim().max(80).default("standard"),
  shippingProfile: shippingProfileSchema,
  translations,
};

export const createProductSchema = z
  .object({
    ...productFields,
    attributes: z.array(attributeSchema).max(100).default([]),
    variants: z.array(createVariantSchema).min(1).max(250),
    media: z.array(createMediaSchema).max(100).default([]),
  })
  .superRefine(validateProduct);

export const updateProductSchema = z
  .object({
    ...productFields,
    version: z.number().int().positive(),
    attributes: z.array(attributeSchema).max(100).default([]),
    variants: z.array(updateVariantSchema).min(1).max(250),
    media: z.array(updateMediaSchema).max(100).default([]),
  })
  .superRefine((value, context) => {
    validateProduct(value, context);
    if (
      value.variants.filter(
        (item) => item.isDefault && item.status === "active",
      ).length !== 1
    )
      context.addIssue({
        code: "custom",
        path: ["variants"],
        message: "Exactly one active variant must be the default.",
      });
  });
