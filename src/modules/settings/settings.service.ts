import { z } from "zod";
import { env } from "../../config/env.js";
import {
  FeatureFlag,
  IntegrationCredential,
  MediaAsset,
  StoreSetting,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { recordAudit } from "../audits/audit.service.js";
import { mediaPublicUrl } from "../media/media.storage.js";
import { listPublicShippingMethods } from "../shipping/shipping.service.js";
import type { Request } from "express";

const localizedText: RuntimeValue = z.object({
  en: z.string().trim().min(1).max(255),
  bn: z.string().trim().min(1).max(255),
});
const optionalUrl: RuntimeValue = z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().url().max(1000).nullable().optional(),
);
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function mergeSettingValues(...values: unknown[]) {
  const result: Record<string, unknown> = {};
  for (const value of values) {
    if (!isPlainObject(value)) continue;
    for (const [key, next] of Object.entries(value)) {
      result[key] =
        isPlainObject(result[key]) && isPlainObject(next)
          ? mergeSettingValues(result[key], next)
          : next;
    }
  }
  return result;
}
const schemas: RuntimeValue = {
  store: z.object({
    name: localizedText,
    currency: z.literal("BDT"),
    timezone: z.literal("Asia/Dhaka"),
    contactPhone: z.string().max(30),
    contactEmail: z
      .union([z.literal(""), z.email().max(190)])
      .optional()
      .default(""),
    address: z.string().max(1000).optional().default(""),
    whatsappUrl: optionalUrl,
    logo: z
      .object({
        mediaId: z.string().length(26),
        url: optionalUrl,
        altText: z.string().max(500).nullable().optional(),
      })
      .nullable()
      .optional()
      .default(null),
    socialLinks: z
      .array(
        z.object({
          label: z.string().max(80),
          url: z.string().url().max(1000),
        }),
      )
      .max(20)
      .default([]),
  }),
  ordering: z.object({
    minimumOrder: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .default("0.00"),
    maximumItemQuantity: z.number().int().min(1).max(999).default(99),
    allowGuestCheckout: z.boolean().default(true),
    orderPrefix: z
      .string()
      .regex(/^[A-Z0-9-]{1,12}$/)
      .default("EE"),
  }),
  inventory: z.object({
    defaultStockPolicy: z
      .enum(["deny", "allow_backorder", "preorder", "available"])
      .default("deny"),
    lowStockThreshold: z.number().int().min(0).max(1_000_000).default(3),
    showExactStock: z.boolean().default(true),
    reservationMinutes: z.number().int().min(5).max(120).default(15),
  }),
  checkout: z.object({
    termsPageSlug: z.string().max(180).default("terms"),
    orderNotesEnabled: z.boolean().default(true),
    requireTermsAcceptance: z.boolean().default(true),
  }),
  tax: z.object({
    enabled: z.boolean().default(false),
    pricesIncludeTax: z.boolean().default(true),
    rate: z
      .string()
      .regex(/^\d{1,2}(\.\d{1,4})?$/)
      .default("0"),
  }),
  verification: z.object({
    requirePhoneVerification: z.boolean().default(false),
    requireEmailVerification: z.boolean().default(false),
    staffMfaRequired: z.boolean().default(false),
  }),
  returns: z.object({
    enabled: z.boolean().default(true),
    windowDays: z.number().int().min(0).max(365).default(7),
    guestReturns: z.boolean().default(true),
    excludedProductIds: z.array(z.string().length(26)).max(1000).default([]),
  }),
  reviews: z.object({
    enabled: z.boolean().default(true),
    moderationRequired: z.boolean().default(true),
    allowUpdates: z.boolean().default(false),
    mediaEnabled: z.boolean().default(true),
  }),
  notifications: z.object({
    emailEnabled: z.boolean().default(true),
    smsEnabled: z.boolean().default(false),
    orderEvents: z.array(z.string().max(100)).max(100).default([]),
  }),
  analytics: z.object({
    consentRequired: z.boolean().default(true),
    provider: z.enum(["none", "ga4", "meta"]).default("none"),
    publicMeasurementId: z.string().max(100).nullable().optional(),
  }),
  seo: z.object({
    defaultTitle: z.string().max(255),
    defaultDescription: z.string().max(500),
    robotsIndex: z.boolean().default(true),
    socialImageId: z.string().length(26).nullable().optional(),
  }),
  maintenance: z.object({
    enabled: z.boolean().default(false),
    message: localizedText.optional(),
    allowAdmin: z.boolean().default(true),
  }),
};

export const defaultPublicSettings: RuntimeValue = {
  store: {
    name: { en: "Elite Emporium", bn: "এলিট এম্পোরিয়াম" },
    currency: "BDT",
    timezone: "Asia/Dhaka",
    contactPhone: "+8801700000000",
    contactEmail: "",
    address: "",
    whatsappUrl: null,
    logo: null,
    socialLinks: [],
  },
  ordering: {
    minimumOrder: "0.00",
    maximumItemQuantity: 99,
    allowGuestCheckout: true,
    orderPrefix: "EE",
  },
  inventory: {
    defaultStockPolicy: "deny",
    lowStockThreshold: 3,
    showExactStock: true,
    reservationMinutes: 15,
  },
  checkout: {
    termsPageSlug: "terms",
    orderNotesEnabled: true,
    requireTermsAcceptance: true,
  },
  tax: { enabled: false, pricesIncludeTax: true, rate: "0" },
  verification: {
    requirePhoneVerification: false,
    requireEmailVerification: false,
    staffMfaRequired: false,
  },
  returns: {
    enabled: true,
    windowDays: 7,
    guestReturns: true,
    excludedProductIds: [],
  },
  reviews: {
    enabled: true,
    moderationRequired: true,
    allowUpdates: false,
    mediaEnabled: true,
  },
  notifications: { emailEnabled: true, smsEnabled: false, orderEvents: [] },
  analytics: {
    consentRequired: true,
    provider: "none",
    publicMeasurementId: null,
  },
  seo: {
    defaultTitle: "Elite Emporium",
    defaultDescription:
      "Discover thoughtfully selected fashion from Elite Emporium.",
    robotsIndex: true,
    socialImageId: null,
  },
  maintenance: {
    enabled: false,
    message: { en: "We will be back shortly.", bn: "আমরা শীঘ্রই ফিরে আসব।" },
    allowAdmin: true,
  },
  payments: {
    cod: { enabled: true, default: true },
    bkash: { enabled: false },
  },
  theme: {
    primary: "#6f1d46",
    accent: "#d4a373",
    background: "#fffaf7",
    text: "#24151d",
    radius: "0.75rem",
  },
};

const publicGroups = new Set([
  "store",
  "ordering",
  "inventory",
  "checkout",
  "tax",
  "verification",
  "returns",
  "reviews",
  "analytics",
  "seo",
  "maintenance",
]);

export async function getPublicSettings() {
  const [rows, shippingMethods, bkashFlag, bkashCredential]: RuntimeValue =
    await Promise.all([
      StoreSetting.findAll({ where: { isPublic: true } }),
      listPublicShippingMethods("en"),
      FeatureFlag.findOne({ where: { key: "bkash" } }),
      IntegrationCredential.findOne({
        where: { provider: "bkash", environment: env.BKASH_MODE },
      }),
    ]);
  const settings: Record<
    string,
    ReturnType<typeof JSON.parse>
  > = structuredClone(defaultPublicSettings);
  for (const row of rows) {
    if (publicGroups.has(row.key) || row.key === "theme") {
      const value = row.value;
      settings[row.key] = typeof value === 'string' ? JSON.parse(value) : value;
    }
  }
  settings.shippingMethods = shippingMethods.map((method: RuntimeValue) => ({
    code: method.code,
    label: method.labels,
    price: method.price,
    regularPrice: method.regularPrice,
    freeThreshold: method.freeThreshold,
    allowedPayments: method.allowedPayments,
    active: true,
  }));
  settings.payments = {
    cod: { enabled: true, default: true },
    bkash: {
      enabled: Boolean(
        env.BKASH_ENABLED &&
        bkashFlag?.enabled &&
        bkashFlag.config?.tested &&
        bkashCredential?.active &&
        bkashCredential.testStatus === "success",
      ),
    },
  };
  settings.features = {
    automaticZoneMatching: false,
    requirePhoneVerification: settings.verification.requirePhoneVerification,
    requireEmailVerification: settings.verification.requireEmailVerification,
    taxEnabled: settings.tax.enabled,
  };
  return settings;
}

export async function listSettingGroups() {
  const rows: RuntimeValue = await StoreSetting.findAll({
    order: [["key", "ASC"]],
  });
  const byKey: RuntimeValue = new Map(
    rows.map((row: RuntimeValue) => [row.key, row]),
  );
  return Object.keys(schemas).map((key: RuntimeValue) => {
    const raw = byKey.get(key)?.value ??
      (defaultPublicSettings as Record<string, unknown>)[key] ??
      {};
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      key,
      value,
      version: byKey.get(key)?.version ?? 0,
      isPublic: publicGroups.has(key),
      updatedAt: byKey.get(key)?.updatedAt || null,
    };
  });
}

export async function getSettingGroup(key: string) {
  if (!(key in schemas)) throw AppError.notFound("Settings group not found.");
  const row: RuntimeValue = await StoreSetting.findOne({ where: { key } });
  const raw = row?.value ??
    (defaultPublicSettings as Record<string, unknown>)[key] ??
    {};
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    key,
    value,
    version: row?.version ?? 0,
    isPublic: publicGroups.has(key),
    updatedAt: row?.updatedAt || null,
  };
}

export async function updateSettingGroup(
  key: string,
  value: unknown,
  expectedVersion: number,
  actorId: string,
  request: Request,
) {
  const schema = schemas[key as keyof typeof schemas];
  if (!schema) throw AppError.notFound("Settings group not found.");
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    let row: RuntimeValue = await StoreSetting.findOne({
      where: { key },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (row && Number(expectedVersion) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "These settings changed. Refresh and review the latest version.",
      );
    if (!row && Number(expectedVersion) !== 0)
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "These settings changed. Refresh and review the latest version.",
      );
    const before = row?.value || null;
    const candidate = mergeSettingValues(
      (defaultPublicSettings as Record<string, unknown>)[key],
      row?.value,
      value,
    );
    const parsed: RuntimeValue = schema.safeParse(candidate);
    if (!parsed.success)
      throw AppError.unprocessable(
        "INVALID_SETTINGS",
        "Check the settings values.",
        Object.fromEntries(
          parsed.error.issues.map((issue: RuntimeValue) => [
            issue.path.join(".") || "_form",
            [issue.message],
          ]),
        ),
      );
    if (key === "store" && parsed.data.logo?.mediaId) {
      const logo: RuntimeValue = await MediaAsset.findOne({
        where: {
          id: parsed.data.logo.mediaId,
          kind: "image",
          privacy: "public",
          status: "ready",
        },
        transaction,
      });
      if (!logo)
        throw AppError.unprocessable(
          "INVALID_STORE_LOGO",
          "Choose a ready public image for the store logo.",
          { logo: ["Choose a ready public image for the store logo."] },
        );
      const logoUrl = mediaPublicUrl(logo.storageKey);
      if (!logoUrl)
        throw AppError.unprocessable(
          "INVALID_STORE_LOGO",
          "Choose a public image for the store logo.",
          { logo: ["Choose a public image for the store logo."] },
        );
      parsed.data.logo = {
        mediaId: logo.id,
        url: logoUrl,
        altText: parsed.data.logo.altText || logo.altText || null,
      };
    }
    if (!row)
      row = await StoreSetting.create(
        {
          id: newId(),
          key,
          value: parsed.data,
          isPublic: publicGroups.has(key),
          version: 1,
        },
        { transaction },
      );
    else
      await row.update(
        {
          value: parsed.data,
          isPublic: publicGroups.has(key),
          version: row.version + 1,
        },
        { transaction },
      );
    await recordAudit({
      actorId,
      action: "settings.update",
      resourceType: "settings",
      resourceId: row.id,
      before,
      after: parsed.data,
      metadata: { group: key },
      request,
      transaction,
    });
    return {
      key,
      value: row.value,
      version: row.version,
      isPublic: row.isPublic,
      updatedAt: row.updatedAt,
    };
  });
}
