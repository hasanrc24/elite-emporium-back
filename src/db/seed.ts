import argon2 from "argon2";
import {
  Category,
  CategoryTranslation,
  FeatureFlag,
  HomepageSection,
  InventoryLevel,
  Menu,
  MenuItem,
  NotificationTemplate,
  Page,
  PageTranslation,
  Permission,
  Product,
  ProductTranslation,
  ProductVariant,
  Role,
  ShippingMethod,
  ShippingZone,
  StockLocation,
  StoreSetting,
  ThemeSetting,
  User,
} from "./models.js";
import type { DynamicModel } from "./models/shared.js";
import { sequelize } from "./sequelize.js";
import { env } from "../config/env.js";
import { newId } from "../lib/ids.js";
import { normalizeEmail, normalizePhone } from "../lib/normalization.js";
import { defaultPublicSettings } from "../modules/settings/settings.service.js";
import { logger } from "../lib/logger.js";

const permissionDefinitions = [
  ["admin.access", "Access administration"],
  ["dashboard.view", "View business dashboard"],
  ["catalog.view", "View catalog administration"],
  ["catalog.manage", "Create and edit catalog"],
  ["catalog.publish", "Publish and archive catalog"],
  ["catalog.import", "Import catalog data"],
  ["catalog.export", "Export catalog data"],
  ["inventory.view", "View inventory and movements"],
  ["inventory.adjust", "Adjust and reconcile inventory"],
  ["orders.view", "View orders"],
  ["orders.create", "Create manual orders"],
  ["orders.edit", "Edit eligible orders"],
  ["orders.progress", "Progress fulfillment"],
  ["orders.cancel", "Cancel eligible orders"],
  ["orders.export", "Export orders"],
  ["orders.override_price", "Override order prices with a reason"],
  ["payments.view", "View payment records"],
  ["payments.refund", "Create refunds"],
  ["payments.reconcile", "Reconcile provider payments"],
  ["returns.view", "View return requests"],
  ["returns.manage", "Process returns and exchanges"],
  ["customers.view", "View customer profiles"],
  ["customers.manage", "Manage customer status and notes"],
  ["customers.export", "Export customer data"],
  ["promotions.manage", "Manage coupons and scheduled promotions"],
  ["reviews.moderate", "Moderate customer reviews"],
  ["cms.manage", "Manage structured content and appearance"],
  ["cms.publish", "Publish and roll back content"],
  ["media.manage", "Upload and manage media"],
  ["notifications.manage", "Manage templates and delivery retries"],
  ["reports.view", "View reports"],
  ["reports.export", "Create report exports"],
  ["settings.manage", "Manage business settings"],
  ["integrations.manage", "Manage encrypted integration credentials"],
  ["staff.view", "View staff"],
  ["staff.manage", "Manage staff"],
  ["roles.manage", "Manage roles and permissions"],
  ["audits.view", "View audit records"],
  ["audits.export", "Export audit records"],
  ["webhooks.manage", "Manage outbound webhooks"],
];

try {
  await sequelize.transaction(async (transaction) => {
    const permissions: Record<string, DynamicModel> = {};
    for (const [key, description] of permissionDefinitions) {
      const module = key.split(".")[0];
      const [permission] = await Permission.findOrCreate({
        where: { key },
        defaults: { id: newId(), key, module, description },
        transaction,
      });
      if (
        permission.module !== module ||
        permission.description !== description
      )
        await permission.update({ module, description }, { transaction });
      permissions[key] = permission;
    }
    const roleDefinitions = {
      owner: permissionDefinitions.map(([key]) => key),
      administrator: permissionDefinitions
        .map(([key]) => key)
        .filter((key) => !["roles.manage"].includes(key)),
      order_manager: [
        "admin.access",
        "dashboard.view",
        "orders.view",
        "orders.create",
        "orders.edit",
        "orders.progress",
        "orders.cancel",
        "orders.export",
        "payments.view",
        "returns.view",
        "returns.manage",
        "customers.view",
        "inventory.view",
        "reports.view",
      ],
      catalog_manager: [
        "admin.access",
        "dashboard.view",
        "catalog.view",
        "catalog.manage",
        "catalog.publish",
        "catalog.import",
        "catalog.export",
        "inventory.view",
        "inventory.adjust",
        "media.manage",
        "reports.view",
      ],
      marketing: [
        "admin.access",
        "dashboard.view",
        "catalog.view",
        "promotions.manage",
        "reviews.moderate",
        "cms.manage",
        "cms.publish",
        "media.manage",
        "reports.view",
      ],
      support: [
        "admin.access",
        "dashboard.view",
        "orders.view",
        "returns.view",
        "customers.view",
      ],
      read_only: [
        "admin.access",
        "dashboard.view",
        "catalog.view",
        "inventory.view",
        "orders.view",
        "payments.view",
        "returns.view",
        "customers.view",
        "reports.view",
      ],
      customer: [],
    };
    const roles: Record<string, DynamicModel> = {};
    for (const [key, permissionKeys] of Object.entries(roleDefinitions)) {
      const [role] = await Role.findOrCreate({
        where: { key },
        defaults: {
          id: newId(),
          key,
          name: key
            .split("_")
            .map((part) => part[0].toUpperCase() + part.slice(1))
            .join(" "),
          protected: ["owner", "customer"].includes(key),
          system: true,
          active: true,
        },
        transaction,
      });
      await role.setPermissions(
        permissionKeys.map((permissionKey) => permissions[permissionKey]),
        { transaction },
      );
      roles[key] = role;
    }
    const phone = normalizePhone(env.OWNER_PHONE);
    const email = normalizeEmail(env.OWNER_EMAIL);
    const [owner] = await User.findOrCreate({
      where: { email },
      defaults: {
        id: newId(),
        name: env.OWNER_NAME,
        phone,
        email,
        passwordHash: await argon2.hash(env.OWNER_PASSWORD, {
          type: argon2.argon2id,
        }),
        status: "active",
        locale: "en",
        mustChangePassword: true,
      },
      transaction,
    });
    await owner.addRole(roles.owner, { transaction });

    for (const [key, value] of Object.entries(defaultPublicSettings)) {
      await StoreSetting.findOrCreate({
        where: { key },
        defaults: { id: newId(), key, value, isPublic: true, version: 1 },
        transaction,
      });
    }

    for (const [key, enabled, config] of [
      ["verification_capability", true, {}],
      ["require_phone_verification", false, {}],
      ["require_email_verification", false, {}],
      ["bkash", false, { tested: false }],
      ["automatic_zone_matching", false, {}],
      ["tax", false, {}],
      ["courier_automation", false, {}],
      ["maintenance_mode", false, {}],
    ])
      await FeatureFlag.findOrCreate({
        where: { key },
        defaults: { id: newId(), key, enabled, config },
        transaction,
      });

    const [location] = await StockLocation.findOrCreate({
      where: { code: "main" },
      defaults: {
        id: newId(),
        code: "main",
        name: "Elite Emporium Main Stock",
        active: true,
      },
      transaction,
    });
    const [insideZone] = await ShippingZone.findOrCreate({
      where: { code: "inside_dhaka" },
      defaults: {
        id: newId(),
        code: "inside_dhaka",
        nameEn: "Inside Dhaka",
        nameBn: "ঢাকার ভিতরে",
        matchMode: "selector",
        priority: 1,
        active: true,
      },
      transaction,
    });
    const [outsideZone] = await ShippingZone.findOrCreate({
      where: { code: "outside_dhaka" },
      defaults: {
        id: newId(),
        code: "outside_dhaka",
        nameEn: "Outside Dhaka",
        nameBn: "ঢাকার বাইরে",
        matchMode: "selector",
        priority: 2,
        active: true,
      },
      transaction,
    });
    await ShippingMethod.findOrCreate({
      where: { code: "inside_dhaka" },
      defaults: {
        id: newId(),
        zoneId: insideZone.id,
        code: "inside_dhaka",
        type: "flat_rate",
        labelEn: "Inside Dhaka",
        labelBn: "ঢাকার ভিতরে",
        flatRate: "80.00",
        allowedPayments: ["cod", "bkash"],
        active: true,
        displayOrder: 1,
      },
      transaction,
    });
    await ShippingMethod.findOrCreate({
      where: { code: "outside_dhaka" },
      defaults: {
        id: newId(),
        zoneId: outsideZone.id,
        code: "outside_dhaka",
        type: "flat_rate",
        labelEn: "Outside Dhaka",
        labelBn: "ঢাকার বাইরে",
        flatRate: "150.00",
        allowedPayments: ["cod", "bkash"],
        active: true,
        displayOrder: 2,
      },
      transaction,
    });

    const [category] = await Category.findOrCreate({
      where: { slug: "new-arrivals" },
      defaults: {
        id: newId(),
        slug: "new-arrivals",
        active: true,
        displayOrder: 1,
      },
      transaction,
    });
    for (const [locale, name] of [
      ["en", "New Arrivals"],
      ["bn", "নতুন কালেকশন"],
    ])
      await CategoryTranslation.findOrCreate({
        where: { categoryId: category.id, locale },
        defaults: {
          id: newId(),
          categoryId: category.id,
          locale,
          name,
          description: "",
        },
        transaction,
      });
    const [product, created] = await Product.findOrCreate({
      where: { slug: "signature-floral-dress" },
      defaults: {
        id: newId(),
        categoryId: category.id,
        slug: "signature-floral-dress",
        type: "variable",
        status: "published",
        featured: true,
        publishedAt: new Date(),
      },
      transaction,
    });
    if (created) {
      await ProductTranslation.bulkCreate(
        [
          {
            id: newId(),
            productId: product.id,
            locale: "en",
            name: "Signature Floral Dress",
            shortDescription: "An elegant everyday floral dress.",
            description:
              "Soft fabric, comfortable fit, and a graceful silhouette.",
          },
          {
            id: newId(),
            productId: product.id,
            locale: "bn",
            name: "সিগনেচার ফ্লোরাল ড্রেস",
            shortDescription: "মার্জিত ও আরামদায়ক ফ্লোরাল ড্রেস।",
            description: "নরম কাপড়, আরামদায়ক ফিট এবং সুন্দর ডিজাইন।",
          },
        ],
        { transaction },
      );
      for (const [size, stock] of [
        ["S", 8],
        ["M", 12],
        ["L", 7],
      ]) {
        const variant = await ProductVariant.create(
          {
            id: newId(),
            productId: product.id,
            sku: `EE-FLORAL-${size}`,
            title: `Size ${size}`,
            attributes: { size },
            regularPrice: "1850.00",
            salePrice: size === "M" ? "1690.00" : null,
            costPrice: "1100.00",
            stockPolicy: "deny",
            active: true,
            isDefault: size === "M",
          },
          { transaction },
        );
        await InventoryLevel.create(
          {
            id: newId(),
            variantId: variant.id,
            locationId: location.id,
            onHand: stock,
            reserved: 0,
            lowStockThreshold: 3,
          },
          { transaction },
        );
      }
    }

    const notificationEvents = [
      "order.placed",
      "order.confirmed",
      "order.shipped",
      "order.delivered",
      "order.cancelled",
      "payment.paid",
      "payment.failed",
      "return.requested",
      "return.updated",
      "inventory.low_stock",
    ];
    for (const event of notificationEvents) {
      for (const templateLocale of ["en", "bn"]) {
        await NotificationTemplate.findOrCreate({
          where: { event, channel: "email", locale: templateLocale },
          defaults: {
            id: newId(),
            event,
            channel: "email",
            locale: templateLocale,
            subject:
              templateLocale === "bn"
                ? "Elite Emporium আপডেট"
                : "Elite Emporium update",
            body:
              templateLocale === "bn"
                ? "আপনার Elite Emporium অনুরোধের একটি আপডেট আছে: {{message}}"
                : "There is an update to your Elite Emporium request: {{message}}",
            variables: ["message"],
            active: true,
          },
          transaction,
        });
      }
    }
    for (const templateLocale of ["en", "bn"]) {
      for (const channel of ["email", "sms"]) {
        await NotificationTemplate.findOrCreate({
          where: { event: "account.verify", channel, locale: templateLocale },
          defaults: {
            id: newId(),
            event: "account.verify",
            channel,
            locale: templateLocale,
            subject:
              channel === "email"
                ? templateLocale === "bn"
                  ? "আপনার অ্যাকাউন্ট যাচাই করুন"
                  : "Verify your account"
                : null,
            body:
              templateLocale === "bn"
                ? "আপনার Elite Emporium যাচাইকরণ কোড: {{code}}। মেয়াদ: {{expiresAt}}"
                : "Your Elite Emporium verification code is {{code}}. It expires at {{expiresAt}}.",
            variables: ["code", "expiresAt"],
            active: true,
          },
          transaction,
        });
        await NotificationTemplate.findOrCreate({
          where: {
            event: "account.password_reset",
            channel,
            locale: templateLocale,
          },
          defaults: {
            id: newId(),
            event: "account.password_reset",
            channel,
            locale: templateLocale,
            subject:
              channel === "email"
                ? templateLocale === "bn"
                  ? "পাসওয়ার্ড রিসেট করুন"
                  : "Reset your password"
                : null,
            body:
              templateLocale === "bn"
                ? "আপনার Elite Emporium পাসওয়ার্ড রিসেট করুন: {{resetUrl}}"
                : "Reset your Elite Emporium password: {{resetUrl}}",
            variables: ["resetUrl"],
            active: true,
          },
          transaction,
        });
      }
    }

    const [publishedTheme] = await ThemeSetting.findOrCreate({
      where: { status: "published" },
      defaults: {
        id: newId(),
        status: "published",
        settings: defaultPublicSettings.theme,
        version: 1,
        publishedAt: new Date(),
      },
      transaction,
    });
    await ThemeSetting.findOrCreate({
      where: { status: "draft" },
      defaults: {
        id: newId(),
        status: "draft",
        settings: publishedTheme.settings,
        version: 1,
      },
      transaction,
    });
    await HomepageSection.findOrCreate({
      where: { type: "hero", status: "published" },
      defaults: {
        id: newId(),
        type: "hero",
        enabled: true,
        displayOrder: 1,
        status: "published",
        config: {
          eyebrow: { en: "New collection", bn: "নতুন কালেকশন" },
          title: {
            en: "Elegance for every day",
            bn: "প্রতিদিনের জন্য আভিজাত্য",
          },
          body: {
            en: "Discover dresses selected for comfort and confidence.",
            bn: "আরাম ও আত্মবিশ্বাসের জন্য বাছাই করা পোশাক দেখুন।",
          },
          cta: { label: { en: "Shop now", bn: "এখনই কিনুন" }, href: "/shop" },
        },
      },
      transaction,
    });
    await HomepageSection.findOrCreate({
      where: { type: "product_carousel", status: "published" },
      defaults: {
        id: newId(),
        type: "product_carousel",
        enabled: true,
        displayOrder: 2,
        status: "published",
        config: {
          title: { en: "Featured products", bn: "নির্বাচিত পণ্য" },
          query: { featured: true, limit: 8 },
        },
      },
      transaction,
    });
    const [headerMenu] = await Menu.findOrCreate({
      where: { location: "header" },
      defaults: {
        id: newId(),
        location: "header",
        name: "Primary navigation",
        status: "published",
      },
      transaction,
    });
    for (const [order, targetType, targetId, url, labelEn, labelBn] of [
      [1, "url", null, "/shop", "Shop", "শপ"],
      [
        2,
        "category",
        category?.id || null,
        null,
        "New Arrivals",
        "নতুন কালেকশন",
      ],
      [3, "url", null, "/contact", "Contact", "যোগাযোগ"],
    ]) {
      await MenuItem.findOrCreate({
        where: { menuId: headerMenu.id, displayOrder: order },
        defaults: {
          id: newId(),
          menuId: headerMenu.id,
          targetType,
          targetId,
          url,
          labelEn,
          labelBn,
          displayOrder: order,
          visible: true,
        },
        transaction,
      });
    }
    for (const [slug, titleEn, titleBn] of [
      ["privacy-policy", "Privacy Policy", "গোপনীয়তা নীতি"],
      ["terms", "Terms and Conditions", "শর্তাবলী"],
      [
        "return-policy",
        "Return and Exchange Policy",
        "রিটার্ন ও এক্সচেঞ্জ নীতি",
      ],
    ]) {
      const [page, pageCreated] = await Page.findOrCreate({
        where: { slug },
        defaults: {
          id: newId(),
          slug,
          template: "policy",
          status: "draft",
          version: 1,
        },
        transaction,
      });
      if (pageCreated)
        await PageTranslation.bulkCreate(
          [
            {
              id: newId(),
              pageId: page.id,
              locale: "en",
              title: titleEn,
              excerpt: "",
              blocks: [
                {
                  type: "rich_text",
                  content: [
                    {
                      type: "paragraph",
                      text: "Replace this draft with approved owner-provided policy copy before launch.",
                    },
                  ],
                },
              ],
            },
            {
              id: newId(),
              pageId: page.id,
              locale: "bn",
              title: titleBn,
              excerpt: "",
              blocks: [
                {
                  type: "rich_text",
                  content: [
                    {
                      type: "paragraph",
                      text: "লঞ্চের আগে মালিক কর্তৃক অনুমোদিত নীতিমালা এখানে যোগ করুন।",
                    },
                  ],
                },
              ],
            },
          ],
          { transaction },
        );
    }
  });
  logger.info("Seed completed");
  await sequelize.close();
} catch (error) {
  logger.error({ err: error }, "Seed failed");
  await sequelize.close();
  process.exitCode = 1;
}
