import argon2 from "argon2";
import {
  Attribute,
  AttributeTranslation,
  AttributeValue,
  AttributeValueTranslation,
  BdLocation,
  Category,
  CategoryTranslation,
  FeatureFlag,
  HomepageSection,
  Menu,
  MenuItem,
  NotificationTemplate,
  Page,
  PageTranslation,
  Permission,
  Role,
  SearchSynonym,
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
import { bdLocationSeeds } from "./data/bd-locations.js";
import { catalogAttributeSeeds } from "./data/catalog-attributes.js";
import { newId } from "../lib/ids.js";
import { normalizeEmail, normalizePhone } from "../lib/normalization.js";
import {
  defaultPublicSettings,
  isPublicSettingGroup,
} from "../modules/settings/settings.service.js";
import { logger } from "../lib/logger.js";

// Starter Banglish/Bangla/English garment terms; owners extend them in admin.
const searchSynonymSeeds: [string, string[]][] = [
  ["salwar", ["shalwar", "selwar", "সালোয়ার", "সেলোয়ার"]],
  ["kameez", ["kamiz", "kamij", "কামিজ"]],
  ["saree", ["sari", "shari", "শাড়ি"]],
  ["orna", ["dupatta", "urna", "ওড়না"]],
  ["kurti", ["kurta", "কুর্তি", "কুর্তা"]],
  ["abaya", ["borka", "burqa", "বোরকা", "আবায়া"]],
  ["three piece", ["3 piece", "threepiece", "থ্রি পিস"]],
  ["dress", ["frock", "gown", "ড্রেস", "জামা"]],
  ["lehenga", ["lehnga", "লেহেঙ্গা"]],
  ["hijab", ["hijaab", "হিজাব"]],
];

const permissionDefinitions = [
  ["admin.access", "Access administration"],
  ["dashboard.view", "View business dashboard"],
  ["catalog.view", "View catalog administration"],
  ["catalog.manage", "Create and edit catalog"],
  ["catalog.publish", "Publish and archive catalog"],
  ["catalog.import", "Import catalog data"],
  ["catalog.export", "Export catalog data"],
  ["catalog.cost", "View and edit variant cost prices"],
  ["inventory.view", "View inventory and movements"],
  ["inventory.adjust", "Adjust and reconcile inventory"],
  ["orders.view", "View orders"],
  ["orders.create", "Create manual orders"],
  ["orders.edit", "Edit eligible orders"],
  ["orders.progress", "Progress fulfillment"],
  ["orders.cancel", "Cancel eligible orders"],
  ["orders.export", "Export orders"],
  ["orders.override_price", "Override order prices with a reason"],
  ["orders.confirm", "Confirm new orders by phone or link"],
  ["risk.view", "View order risk signals"],
  ["risk.manage", "Manage the blocklist and risk rules"],
  ["search.manage", "Manage search synonyms"],
  ["payments.view", "View payment records"],
  ["payments.refund", "Create refunds"],
  ["payments.reconcile", "Reconcile provider payments"],
  ["payments.verify_manual", "Verify manual mobile-wallet payments"],
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
        "orders.confirm",
        "risk.view",
        "payments.view",
        "payments.verify_manual",
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
        "catalog.cost",
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
        "search.manage",
        "reports.view",
      ],
      support: [
        "admin.access",
        "dashboard.view",
        "orders.view",
        "orders.confirm",
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
        defaults: {
          id: newId(),
          key,
          value,
          isPublic: isPublicSettingGroup(key),
          version: 1,
        },
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

    await StockLocation.findOrCreate({
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
    // Seeded inactive: the owner enables the suburb rate when couriers charge it.
    const [suburbZone] = await ShippingZone.findOrCreate({
      where: { code: "dhaka_suburb" },
      defaults: {
        id: newId(),
        code: "dhaka_suburb",
        nameEn: "Dhaka Suburbs",
        nameBn: "ঢাকার পার্শ্ববর্তী এলাকা",
        matchMode: "selector",
        priority: 3,
        active: false,
      },
      transaction,
    });
    await ShippingMethod.findOrCreate({
      where: { code: "dhaka_suburb" },
      defaults: {
        id: newId(),
        zoneId: suburbZone.id,
        code: "dhaka_suburb",
        type: "flat_rate",
        labelEn: "Dhaka Suburbs (Savar, Gazipur, Narayanganj)",
        labelBn: "ঢাকার পার্শ্ববর্তী (সাভার, গাজীপুর, নারায়ণগঞ্জ)",
        flatRate: "120.00",
        allowedPayments: ["cod", "bkash"],
        active: false,
        displayOrder: 3,
      },
      transaction,
    });
    let locationOrder = 0;
    for (const row of bdLocationSeeds()) {
      locationOrder += 1;
      const [locationRow, createdLocation] = await BdLocation.findOrCreate({
        where: { code: row.code },
        defaults: { id: newId(), ...row, displayOrder: locationOrder },
        transaction,
      });
      if (!createdLocation)
        await locationRow.update(
          {
            nameEn: row.nameEn,
            nameBn: row.nameBn,
            parentCode: row.parentCode,
          },
          { transaction },
        );
    }
    for (const [term, synonyms] of searchSynonymSeeds)
      await SearchSynonym.findOrCreate({
        where: { term },
        defaults: { id: newId(), term, synonyms, active: true },
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
    // Reusable catalog attributes (BR-CAT-001). Products choose which of these
    // create variants; the storefront filters on the filterable ones.
    for (const [index, definition] of catalogAttributeSeeds.entries()) {
      const [attribute] = await Attribute.findOrCreate({
        where: { key: definition.key },
        defaults: {
          id: newId(),
          key: definition.key,
          type: definition.type,
          filterable: true,
          variationCapable: definition.variation,
          displayOrder: index,
          active: true,
        },
        transaction,
        paranoid: false,
      });
      for (const [locale, label] of Object.entries(definition.label))
        await AttributeTranslation.findOrCreate({
          where: { attributeId: attribute.id, locale },
          defaults: { id: newId(), attributeId: attribute.id, locale, label },
          transaction,
        });
      for (const [order, value] of definition.values.entries()) {
        const slug = value.en.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const [row] = await AttributeValue.findOrCreate({
          where: { attributeId: attribute.id, slug },
          defaults: {
            id: newId(),
            attributeId: attribute.id,
            slug,
            value: value.en,
            colorHex: value.hex || null,
            displayOrder: order,
            active: true,
          },
          transaction,
          paranoid: false,
        });
        for (const [locale, label] of Object.entries({
          en: value.en,
          bn: value.bn,
        }))
          await AttributeValueTranslation.findOrCreate({
            where: { valueId: row.id, locale },
            defaults: { id: newId(), valueId: row.id, locale, label },
            transaction,
          });
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
    // Staff dashboard alerts (admin is English-only). Deactivating one of these
    // templates switches that alert off; editing it rewords the inbox entry.
    for (const event of [
      "order.placed",
      "order.cancelled",
      "order.auto_cancelled",
      "payment.late_capture",
      "return.requested",
      "return.cancelled",
      "inventory.low_stock",
      "catalog.publish_failed",
      "contact.received",
      "notification.delivery_failed",
      "webhook.delivery_failed",
      "export.ready",
      "export.failed",
    ])
      await NotificationTemplate.findOrCreate({
        where: { event, channel: "dashboard", locale: "en" },
        defaults: {
          id: newId(),
          event,
          channel: "dashboard",
          locale: "en",
          subject: "{{title}}",
          body: "{{message}}",
          variables: ["title", "message"],
          active: true,
        },
        transaction,
      });
    // Most Bangladeshi customers give only a phone number, so order events
    // also need SMS templates (kept short for one or two SMS segments).
    for (const event of [
      "order.placed",
      "order.confirmed",
      "order.shipped",
      "order.delivered",
      "order.cancelled",
    ])
      for (const templateLocale of ["en", "bn"])
        await NotificationTemplate.findOrCreate({
          where: { event, channel: "sms", locale: templateLocale },
          defaults: {
            id: newId(),
            event,
            channel: "sms",
            locale: templateLocale,
            subject: null,
            body:
              templateLocale === "bn"
                ? "Elite Emporium: {{message}}"
                : "Elite Emporium: {{message}}",
            variables: ["message"],
            active: true,
          },
          transaction,
        });
    for (const templateLocale of ["en", "bn"])
      await NotificationTemplate.findOrCreate({
        where: {
          event: "order.confirmation_request",
          channel: "sms",
          locale: templateLocale,
        },
        defaults: {
          id: newId(),
          event: "order.confirmation_request",
          channel: "sms",
          locale: templateLocale,
          subject: null,
          body:
            templateLocale === "bn"
              ? "Elite Emporium: অর্ডার {{orderReference}} ({{total}}) নিশ্চিত করতে ক্লিক করুন: {{confirmUrl}}"
              : "Elite Emporium: confirm order {{orderReference}} ({{total}}): {{confirmUrl}}",
          variables: ["orderReference", "total", "confirmUrl"],
          active: true,
        },
        transaction,
      });
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
                  id: newId(),
                  type: "rich_text",
                  data: {
                    html: "<p>Replace this draft with approved owner-provided policy copy before launch.</p>",
                  },
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
                  id: newId(),
                  type: "rich_text",
                  data: {
                    html: "<p>লঞ্চের আগে মালিক কর্তৃক অনুমোদিত নীতিমালা এখানে যোগ করুন।</p>",
                  },
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
