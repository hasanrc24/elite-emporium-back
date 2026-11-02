import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import argon2 from "argon2";
import sharp from "sharp";
import { QueryTypes } from "sequelize";
import type { ModelStatic, Transaction } from "sequelize";
import * as M from "./models.js";
import type { DynamicModel } from "./models/shared.js";
import { sequelize } from "./sequelize.js";
import { env } from "../config/env.js";
import { encryptSecret } from "../lib/encryption.js";
import { processImage } from "../modules/media/media.storage.js";

// Stable IDs make reruns additive and preserve edits to existing demo records.
const id = (key: string) =>
  createHash("sha256")
    .update(`ee-demo-v1:${key}`)
    .digest("hex")
    .slice(0, 26)
    .toUpperCase();
const ago = (days: number) => new Date(Date.now() - days * 86400000);
const counts: Record<string, number> = {};
let transaction: Transaction;
async function put(
  model: ModelStatic<DynamicModel>,
  key: string,
  values: Record<string, unknown>,
) {
  const existing = await model.findByPk(id(key), {
    transaction,
    paranoid: false,
  });
  if (existing) return existing;
  let row: DynamicModel;
  try {
    row = await model.create({ id: id(key), ...values }, { transaction });
  } catch (error) {
    throw new Error(
      `Failed creating ${model.name} (${key}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  counts[model.name] = (counts[model.name] || 0) + 1;
  return row;
}
async function translate(
  model: ModelStatic<DynamicModel>,
  key: string,
  foreignKey: string,
  parentId: string,
  en: Record<string, unknown>,
  bn: Record<string, unknown> = en,
) {
  for (const [locale, values] of [
    ["en", en],
    ["bn", bn],
  ] as const)
    await put(model, `${key}:${locale}`, {
      [foreignKey]: parentId,
      locale,
      ...values,
    });
}

try {
  if (
    env.NODE_ENV === "production" ||
    !["127.0.0.1", "localhost", "::1", "mysql", "db"].includes(env.DB_HOST)
  )
    throw new Error(
      "Demo seeding is restricted to a local, non-production database.",
    );
  await sequelize.transaction(async (tx) => {
    transaction = tx;
    const roles = await M.Role.findAll({ transaction });
    const owner = await M.User.findOne({
      include: [{ model: M.Role, as: "roles", where: { key: "owner" } }],
      transaction,
    });
    if (!owner || !roles.some((r) => r.key === "customer"))
      throw new Error(
        "Run npm run db:seed first to initialize the owner, roles and settings.",
      );
    const passwordHash = await argon2.hash("DemoDev!2026", {
      type: argon2.argon2id,
    });
    const customers: DynamicModel[] = [];
    for (const [i, name] of [
      "Ayesha Rahman",
      "Nusrat Jahan",
      "Farhana Ahmed",
      "Sadia Islam",
      "Maliha Khan",
      "Tania Akter",
    ].entries()) {
      const user = await put(M.User, `customer:${i}`, {
        name: `${name} (Demo)`,
        email: `customer${i + 1}@demo.example`,
        phone: `+880100000000${i}`,
        passwordHash,
        phoneVerifiedAt: ago(40),
        emailVerifiedAt: ago(40),
        locale: i % 2 ? "bn" : "en",
        status: "active",
        createdAt: ago(45),
      });
      await user.addRole(
        roles.find((r) => r.key === "customer"),
        { transaction },
      );
      customers.push(user);
      await put(M.UserAddress, `address:${i}`, {
        userId: user.id,
        label: "Demo home",
        recipientName: user.name,
        phone: user.phone,
        addressLine: `${10 + i} Demo Road`,
        area: "Dhanmondi",
        district: "Dhaka",
        division: "Dhaka",
        postcode: "1209",
        isDefaultShipping: true,
        isDefaultBilling: true,
      });
      await put(M.CustomerNote, `customer-note:${i}`, {
        userId: user.id,
        actorId: owner.id,
        category: "support",
        message: "Demo customer: prefers delivery in the afternoon.",
      });
    }
    for (const roleKey of ["order_manager", "catalog_manager", "support"]) {
      const staff = await put(M.User, `staff:${roleKey}`, {
        name: `Demo ${roleKey.replaceAll("_", " ")}`,
        email: `${roleKey}@demo.example`,
        passwordHash,
        status: "active",
        emailVerifiedAt: ago(30),
        mustChangePassword: false,
      });
      await staff.addRole(
        roles.find((r) => r.key === roleKey),
        { transaction },
      );
    }
    const location = await put(M.StockLocation, "location", {
      code: "demo-warehouse",
      name: "Demo Dhaka Warehouse",
      address: { district: "Dhaka", addressLine: "10 Demo Road" },
      active: true,
    });
    const zone = await put(M.ShippingZone, "zone", {
      code: "demo-dhaka",
      nameEn: "Demo Dhaka delivery",
      nameBn: "ডেমো ঢাকা ডেলিভারি",
      priority: 20,
    });
    await put(M.ShippingMethod, "shipping", {
      zoneId: zone.id,
      code: "demo-standard",
      labelEn: "Demo standard delivery",
      labelBn: "ডেমো সাধারণ ডেলিভারি",
      flatRate: 80,
      allowedPayments: ["cod"],
      type: "flat_rate",
    });
    const brand = await put(M.Brand, "brand", { slug: "demo-atelier" });
    await translate(
      M.BrandTranslation,
      "brand",
      "brandId",
      brand.id,
      {
        name: "Demo Atelier",
        description: "Development collection by Elite Emporium.",
      },
      { name: "ডেমো আটেলিয়ার" },
    );
    const collection = await put(M.Collection, "collection", {
      slug: "demo-everyday-edit",
      displayOrder: 10,
    });
    await translate(
      M.CollectionTranslation,
      "collection",
      "collectionId",
      collection.id,
      {
        name: "Demo Everyday Edit",
        description: "Comfortable everyday styles.",
      },
      { name: "ডেমো প্রতিদিনের কালেকশন" },
    );
    const categories: DynamicModel[] = [];
    for (const [i, name] of [
      "Dresses",
      "Kurtis",
      "Co-ords",
      "Occasionwear",
    ].entries()) {
      const category = await put(M.Category, `category:${i}`, {
        slug: `demo-${name.toLowerCase()}`,
        displayOrder: i + 10,
      });
      await translate(
        M.CategoryTranslation,
        `category:${i}`,
        "categoryId",
        category.id,
        {
          name: `Demo ${name}`,
          description: `Explore our ${name.toLowerCase()} selection.`,
        },
      );
      categories.push(category);
    }
    // Demo products ship with one illustration each; production keeps the
    // default minimum (4) from BR-CAT-003.
    const [catalogSetting] = await M.StoreSetting.findOrCreate({
      where: { key: "catalog" },
      defaults: {
        id: id("setting:catalog"),
        key: "catalog",
        value: { minProductImages: 1 },
        isPublic: false,
      },
      transaction,
    });
    await catalogSetting.update(
      {
        value: {
          ...(typeof catalogSetting.value === "string"
            ? JSON.parse(catalogSetting.value)
            : catalogSetting.value),
          minProductImages: 1,
        },
      },
      { transaction },
    );
    // Demo products use the shared `size` attribute from the base seed, so
    // storefront size filters and size-chart rules apply to them as well.
    const attribute = await M.Attribute.findOne({
      where: { key: "size" },
      transaction,
    });
    if (!attribute)
      throw new Error(
        "Run npm run db:seed first to create the shared catalog attributes.",
      );
    const sizes: DynamicModel[] = [];
    const chart = await put(M.SizeChart, "chart", {
      name: "Demo clothing sizes",
      units: "cm",
      titleEn: "Size guide",
      titleBn: "সাইজ গাইড",
    });
    for (const [i, size] of ["S", "M", "L"].entries()) {
      const value = await M.AttributeValue.findOne({
        where: { attributeId: attribute.id, slug: size.toLowerCase() },
        transaction,
      });
      if (!value) throw new Error(`Size value ${size} is missing.`);
      sizes.push(value);
      await put(M.SizeChartRow, `chart:${size}`, {
        chartId: chart.id,
        labelEn: size,
        labelBn: size,
        cells: { bust: 88 + i * 4, waist: 70 + i * 4, length: 110 + i * 2 },
        displayOrder: i,
      });
    }
    const products: DynamicModel[] = [];
    const variants: DynamicModel[] = [];
    const names = [
      "Rose Midi Dress",
      "Indigo Cotton Kurti",
      "Sage Linen Co-ord",
      "Midnight Occasion Dress",
      "Peach Wrap Dress",
      "Ivory Embroidered Kurti",
      "Terracotta Lounge Set",
      "Plum Evening Dress",
    ];
    const colors = [
      "#b97587",
      "#354c78",
      "#819582",
      "#343347",
      "#daa38c",
      "#cfbf9e",
      "#ad715a",
      "#74516e",
    ];
    for (const [i, name] of names.entries()) {
      const key = `product:${i}`;
      const storageKey = `public/original/demo/product-${i}.webp`;
      const destination = path.resolve(env.MEDIA_ROOT, storageKey);
      await mkdir(path.dirname(destination), { recursive: true });
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1200"><rect width="960" height="1200" fill="#f4efe8"/><ellipse cx="480" cy="970" rx="220" ry="32" fill="#e4dacf"/><path d="M375 200 L300 235 L220 415 L310 465 L350 350 L365 510 L265 910 Q480 980 695 910 L595 510 L610 350 L650 465 L740 415 L660 235 L585 200 Q480 285 375 200Z" fill="${colors[i]}"/><path d="M375 200 Q480 350 585 200 M365 510 Q480 545 595 510" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="7"/><text x="480" y="1060" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#39332e">${name}</text><text x="480" y="1120" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#786b60">ELITE EMPORIUM · DEMO ILLUSTRATION</text></svg>`;
      const buffer = await sharp(Buffer.from(svg)).webp().toBuffer();
      try {
        await writeFile(destination, buffer, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const processed = await processImage(storageKey);
      const media = await put(M.MediaAsset, `media:${i}`, {
        storageKey,
        originalName: `demo-${i}.webp`,
        kind: "image",
        mimeType: "image/webp",
        byteSize: buffer.length,
        checksum: createHash("sha256").update(buffer).digest("hex"),
        width: 960,
        height: 1200,
        status: "ready",
        altText: `Demo illustration of ${name}`,
        metadata: { demo: true, variants: processed.variants },
        uploaderId: owner.id,
      });
      const product = await put(M.Product, key, {
        slug: `demo-${name.toLowerCase().replaceAll(" ", "-")}`,
        categoryId: categories[i % 4].id,
        brandId: brand.id,
        type: "variable",
        status: i === 7 ? "draft" : "published",
        publishedAt: i === 7 ? null : ago(35),
        featured: i < 4,
      });
      products.push(product);
      await translate(M.ProductTranslation, key, "productId", product.id, {
        name: `${name} (Demo)`,
        shortDescription: "A comfortable staple for your everyday wardrobe.",
        description:
          "Demo product for development. Soft fabric, relaxed fit, and careful finishing. Select your preferred size.",
        materialText: "Cotton blend",
        careText: "Gentle cold wash. Dry in shade.",
      });
      await put(M.ProductMedia, `product-media:${i}`, {
        productId: product.id,
        mediaId: media.id,
        role: "primary",
        altEn: name,
        altBn: name,
      });
      await product.addCollection(collection, { transaction });
      await product.addCategory(categories[i % 4], { transaction });
      await product.addSizeChart(chart, { transaction });
      await put(M.ProductAttribute, `product-attribute:${i}`, {
        productId: product.id,
        attributeId: attribute.id,
        variation: true,
        visible: true,
      });
      for (const [s, size] of ["S", "M", "L"].entries()) {
        const variant = await put(M.ProductVariant, `variant:${i}:${s}`, {
          productId: product.id,
          sku: `DEMO-${i + 1}-${size}`,
          title: `Size ${size}`,
          attributes: { size },
          combinationSignature: `size:${size}`,
          regularPrice: 1400 + i * 250,
          costPrice: 800 + i * 100,
          salePrice: i === 0 ? 1250 : null,
          isDefault: s === 1,
          weightGrams: 350,
        });
        await sequelize.query(
          "INSERT IGNORE INTO variant_attribute_values (variantId, attributeId, valueId, createdAt, updatedAt) VALUES (?, ?, ?, NOW(3), NOW(3))",
          {
            replacements: [variant.id, attribute.id, sizes[s].id],
            transaction,
            type: QueryTypes.INSERT,
          },
        );
        if (s === 1) variants.push(variant);
        const stock = i === 6 ? 0 : i === 5 ? 2 : 30;
        await put(M.InventoryLevel, `stock:${i}:${s}`, {
          variantId: variant.id,
          locationId: location.id,
          onHand: stock,
          reserved: 0,
          lowStockThreshold: 3,
        });
        await put(M.InventoryMovement, `stock-opening:${i}:${s}`, {
          variantId: variant.id,
          locationId: location.id,
          actorId: owner.id,
          quantityDelta: stock,
          onHandBefore: 0,
          balanceAfter: stock,
          reservedAfter: 0,
          reason: "opening_stock",
          note: "Demo opening inventory",
          createdAt: ago(40),
        });
      }
    }
    for (const [i, type] of [
      "percentage",
      "fixed_cart",
      "free_delivery",
    ].entries())
      await put(M.Coupon, `coupon:${i}`, {
        code: ["DEMO10", "DEMO200", "DEMOFREE"][i],
        type,
        amount: [10, 200, 0][i],
        minimumSpend: 1000,
        startsAt: ago(10),
        endsAt: ago(-90),
        usageLimit: 100,
        perCustomerLimit: 3,
        active: true,
      });
    for (let i = 0; i < 16; i++) {
      const customer = customers[i % customers.length];
      const p = i % 5;
      const variant = variants[p];
      const delivered = i < 10;
      const cancelled = i === 15;
      const shipped = delivered || i === 10;
      const date = ago(delivered ? 5 + i * 2 : 1);
      const price = Number(variant.salePrice || variant.regularPrice);
      const quantity = i % 3 === 0 ? 2 : 1;
      const total = price * quantity + 80;
      const order = await put(M.Order, `order:${i}`, {
        reference: `DEMO-2026-${String(i + 1).padStart(4, "0")}`,
        userId: customer.id,
        source: "admin",
        orderStatus: delivered
          ? "completed"
          : cancelled
            ? "cancelled"
            : i === 11
              ? "processing"
              : i === 12
                ? "confirmed"
                : "placed",
        paymentStatus: delivered ? "paid" : cancelled ? "cancelled" : "unpaid",
        fulfillmentStatus: delivered
          ? "delivered"
          : i === 10
            ? "shipped"
            : i === 11
              ? "packed"
              : "unfulfilled",
        paymentMethod: "cod",
        customerName: customer.name,
        customerPhone: customer.phone,
        customerEmail: customer.email,
        address: "10 Demo Road, Dhanmondi, Dhaka",
        deliveryCode: "demo-standard",
        deliveryLabel: "Demo standard delivery",
        subtotal: price * quantity,
        deliveryTotal: 80,
        grandTotal: total,
        placedAt: date,
        completedAt: delivered ? new Date(date.getTime() + 86400000) : null,
        cancelledAt: cancelled ? date : null,
        cancellationReason: cancelled
          ? "Demo: customer changed their mind"
          : null,
        createdAt: date,
        metadata: { demo: true },
      });
      const item = await put(M.OrderItem, `order-item:${i}`, {
        orderId: order.id,
        variantId: variant.id,
        productName: `${names[p]} (Demo)`,
        variantTitle: variant.title,
        sku: variant.sku,
        attributes: variant.attributes,
        regularPrice: variant.regularPrice,
        unitPrice: price,
        unitCost: variant.costPrice,
        quantity,
        fulfilledQuantity: shipped ? quantity : 0,
        lineTotal: price * quantity,
      });
      await put(M.OrderAddress, `order-address:${i}`, {
        orderId: order.id,
        type: "shipping",
        recipientName: customer.name,
        phone: customer.phone,
        addressLine: "10 Demo Road",
        district: "Dhaka",
        area: "Dhanmondi",
        deliveryCode: "demo-standard",
      });
      await put(M.OrderEvent, `order-event:${i}`, {
        orderId: order.id,
        actorId: owner.id,
        type: "demo.created",
        message: `Demo order in ${order.orderStatus} state.`,
        createdAt: date,
      });
      await put(M.OrderNote, `order-note:${i}`, {
        orderId: order.id,
        actorId: owner.id,
        visibility: "internal",
        message: "Development fixture. No real shipment or payment.",
      });
      const payment = await put(M.Payment, `payment:${i}`, {
        orderId: order.id,
        method: "cod",
        provider: "manual",
        amount: total,
        status: order.paymentStatus,
        reference: order.reference,
        paidAt: delivered ? order.completedAt : null,
        createdAt: date,
        metadata: { demo: true },
      });
      if (shipped) {
        const shipment = await put(M.Shipment, `shipment:${i}`, {
          orderId: order.id,
          provider: "manual",
          courierName: "Demo Courier",
          consignmentId: `DEMO-TRACK-${i + 1}`,
          fee: 80,
          status: delivered ? "delivered" : "in_transit",
          shippedAt: date,
          deliveredAt: delivered ? order.completedAt : null,
        });
        await put(M.ShipmentEvent, `shipment-event:${i}`, {
          shipmentId: shipment.id,
          type: shipment.status,
          message: "Simulated courier status for development.",
        });
      }
      // Record matching stock reservations and movements once, alongside each fixture.
      const reservationId = id(`reservation:${i}`);
      if (
        !(await M.InventoryReservation.findByPk(reservationId, { transaction }))
      ) {
        const level = await M.InventoryLevel.findByPk(id(`stock:${p}:1`), {
          transaction,
        });
        if (!level) throw new Error("Missing demo inventory level");
        const before = Number(level.onHand);
        const reserved = Number(level.reserved);
        await put(M.InventoryReservation, `reservation:${i}`, {
          orderId: order.id,
          variantId: variant.id,
          locationId: location.id,
          quantity,
          status: cancelled ? "released" : shipped ? "consumed" : "converted",
          expiresAt: ago(-365),
          convertedAt: date,
          consumedAt: shipped ? date : null,
          releasedAt: cancelled ? date : null,
          idempotencyKey: `demo-order-${i}`,
        });
        if (!cancelled) {
          await level.update(
            {
              onHand: before - (shipped ? quantity : 0),
              reserved: reserved + (shipped ? 0 : quantity),
            },
            { transaction },
          );
          await put(M.InventoryMovement, `order-stock:${i}`, {
            orderId: order.id,
            variantId: variant.id,
            locationId: location.id,
            actorId: owner.id,
            quantityDelta: shipped ? -quantity : 0,
            reservedDelta: shipped ? 0 : quantity,
            onHandBefore: before,
            balanceAfter: level.onHand,
            reservedAfter: level.reserved,
            reason: shipped ? "order_fulfilled" : "manual_order_reserved",
            note: "Demo order stock",
            createdAt: date,
          });
        }
      }
      if (i < 6)
        await put(M.Review, `review:${i}`, {
          userId: customer.id,
          productId: products[p].id,
          orderItemId: item.id,
          rating: i % 2 ? 4 : 5,
          title: "Lovely fit and fabric",
          body: "Demo review: comfortable to wear and the size guide was helpful.",
          status: i < 4 ? "approved" : "pending",
          verifiedPurchase: true,
          moderatedBy: i < 4 ? owner.id : null,
          moderatedAt: i < 4 ? ago(2) : null,
        });
      if (i === 0 || i === 1) {
        const request = await put(M.ReturnRequest, `return:${i}`, {
          orderId: order.id,
          userId: customer.id,
          reference: `DEMO-RET-${i + 1}`,
          type: "return",
          status: i === 0 ? "requested" : "received",
          reason: "Size did not fit",
          customerNote: "Demo return for workflow development.",
          resolution: "refund",
          refundAmount: price,
          requestedAt: ago(2),
          receivedAt: i === 1 ? ago(1) : null,
          approvedAt: i === 1 ? ago(2) : null,
          policySnapshot: { windowDays: 30 },
        });
        await put(M.ReturnItem, `return-item:${i}`, {
          returnId: request.id,
          orderItemId: item.id,
          quantity: 1,
          reason: "Size did not fit",
          resolution: "refund",
          condition: i === 1 ? "unworn" : null,
          restock: false,
        });
        await put(M.ReturnEvent, `return-event:${i}`, {
          returnId: request.id,
          actorId: owner.id,
          type: request.status,
          message: "Demo return status.",
        });
        if (i === 1)
          await put(M.Refund, "refund", {
            orderId: order.id,
            paymentId: payment.id,
            returnId: request.id,
            actorId: owner.id,
            amount: price,
            reason: "Demo size return",
            method: "manual",
            status: "pending",
            idempotencyKey: "demo-refund-1",
            metadata: { demo: true },
          });
      }
    }
    for (let i = 0; i < 3; i++) {
      const cart = await put(M.Cart, `cart:${i}`, {
        userId: customers[i].id,
        status: "active",
        expiresAt: ago(-30),
      });
      await put(M.CartItem, `cart-item:${i}`, {
        cartId: cart.id,
        variantId: variants[i].id,
        quantity: 1,
        unitPriceSnapshot: variants[i].salePrice || variants[i].regularPrice,
      });
      const wishlist = await put(M.Wishlist, `wishlist:${i}`, {
        userId: customers[i].id,
        status: "active",
      });
      await put(M.WishlistItem, `wishlist-item:${i}`, {
        wishlistId: wishlist.id,
        productId: products[i].id,
        variantId: variants[i].id,
        itemKey: variants[i].id,
      });
      await put(M.ContactMessage, `contact:${i}`, {
        name: customers[i].name,
        email: customers[i].email,
        subject: [
          "Demo sizing question",
          "Demo delivery enquiry",
          "Demo thank you",
        ][i],
        message: "Sample contact message for developing the support inbox.",
        status: ["new", "in_progress", "resolved"][i],
      });
    }
    await put(M.PrivacyRequest, "privacy", {
      userId: customers[5].id,
      type: "export",
      status: "requested",
      activeKey: `export:${customers[5].id}`,
      requestedAt: ago(1),
      reason: "Demo data export request",
      metadata: { demo: true },
    });
    const blocks = [
      {
        id: "demo-rich-text",
        type: "rich_text",
        data: {
          html: "<p>Demo editorial content for Elite Emporium. Explore comfortable fabrics and thoughtful everyday styling.</p>",
        },
      },
    ];
    for (const slug of ["about", "size-guide", "delivery-guide"]) {
      const page = await put(M.Page, `page:${slug}`, {
        slug: `demo-${slug}`,
        status: "published",
        template: "standard",
      });
      await translate(M.PageTranslation, `page:${slug}`, "pageId", page.id, {
        title: `Demo ${slug.replaceAll("-", " ")}`,
        excerpt: "Development sample page",
        blocks,
      });
      await put(M.ContentRevision, `revision:${slug}`, {
        entityType: "page",
        entityId: page.id,
        actorId: owner.id,
        version: 1,
        // Same shape as content.service revisions so rollback can replay it.
        payload: {
          id: page.id,
          slug: page.slug,
          template: "standard",
          status: page.status,
          publishAt: null,
          version: 1,
          translations: Object.fromEntries(
            ["en", "bn"].map((locale) => [
              locale,
              {
                title: `Demo ${slug.replaceAll("-", " ")}`,
                excerpt: "Development sample page",
                blocks,
                seoTitle: "",
                seoDescription: "",
              },
            ]),
          ),
        },
        changeSummary: "Initial demo content",
        publishedAt: ago(3),
      });
    }
    const postCategory = await put(M.PostCategory, "post-category", {
      slug: "demo-style-notes",
      nameEn: "Demo style notes",
      nameBn: "ডেমো স্টাইল নোট",
    });
    for (let i = 0; i < 3; i++) {
      const post = await put(M.Post, `post:${i}`, {
        slug: `demo-style-journal-${i + 1}`,
        categoryId: postCategory.id,
        authorId: owner.id,
        coverMediaId: id(`media:${i}`),
        type: i === 2 ? "lookbook" : "blog",
        status: i === 1 ? "draft" : "published",
        publishAt: ago(3),
      });
      await translate(M.PostTranslation, `post:${i}`, "postId", post.id, {
        title: [
          "Demo: your everyday wardrobe",
          "Demo: caring for cotton",
          "Demo: the weekend lookbook",
        ][i],
        excerpt: "Simple ideas for everyday style.",
        blocks,
      });
    }
    await put(M.Redirect, "redirect", {
      sourcePath: "/demo-old-collection",
      targetPath: "/collections/demo-everyday-edit",
    });
    const menu = await put(M.Menu, "menu", {
      name: "Demo footer",
      location: "demo-footer",
      status: "draft",
    });
    await put(M.MenuItem, "menu-item", {
      menuId: menu.id,
      targetType: "page",
      targetId: id("page:about"),
      labelEn: "About our store",
      labelBn: "আমাদের সম্পর্কে",
      visible: true,
    });
    await put(M.HomepageSection, "homepage", {
      type: "editorial",
      status: "draft",
      displayOrder: 20,
      config: {
        title: { en: "Demo everyday edit", bn: "ডেমো প্রতিদিনের কালেকশন" },
        body: {
          en: "Explore our development collection.",
          bn: "আমাদের ডেমো কালেকশন দেখুন।",
        },
      },
    });
    await put(M.ExportJob, "export", {
      requestedBy: owner.id,
      report: "orders",
      filters: { demo: true },
      status: "expired",
      expiresAt: ago(1),
    });
    const template = await put(
      M.NotificationTemplate,
      "notification-template",
      {
        event: "demo.preview",
        channel: "dashboard",
        locale: "en",
        subject: "Demo order update",
        body: "Your demo order {{reference}} has been updated.",
        variables: ["reference"],
        active: false,
      },
    );
    for (const [i, status] of ["sent", "dead"].entries())
      await put(M.NotificationOutbox, `notification:${i}`, {
        templateId: template.id,
        event: "demo.preview",
        channel: "dashboard",
        locale: "en",
        recipient: customers[i].id,
        payload: { demo: true, reference: "DEMO-2026-0001" },
        renderedSubject: "Demo order update",
        renderedBody: "Simulated delivery record; no message was sent.",
        status,
        scheduledAt: ago(1),
        sentAt: i === 0 ? ago(1) : null,
        attempts: 1,
        lastError:
          i === 1
            ? "Demo terminal failure for developing delivery views"
            : null,
      });
    await put(M.IntegrationCredential, "integration", {
      provider: "demo",
      environment: "sandbox",
      encryptedPayload: encryptSecret({ demo: true }),
      maskedLabel: "Demo integration (disabled)",
      active: false,
      testStatus: "not_tested",
      updatedBy: owner.id,
    });
    const webhook = await put(M.Webhook, "webhook", {
      name: "Demo order webhook",
      topics: ["order.placed"],
      url: "https://demo.example/webhook",
      encryptedSecret: encryptSecret("demo-disabled-secret"),
      status: "disabled",
    });
    const event = await put(M.OutboxEvent, "outbox", {
      topic: "order.placed",
      aggregateType: "order",
      aggregateId: id("order:0"),
      payload: { demo: true },
      status: "published",
      availableAt: ago(1),
      processedAt: ago(1),
    });
    await put(M.WebhookDelivery, "webhook-delivery", {
      webhookId: webhook.id,
      eventId: event.id,
      attempt: 1,
      status: "dead",
      requestBody: { demo: true },
      errorCode: "DEMO_DISABLED",
      responseExcerpt: "Simulated record; no HTTP request was made.",
    });
    // Reviews are inserted directly, so refresh the per-product aggregates the
    // moderation flow would normally maintain (approved reviews only).
    await sequelize.query(
      `UPDATE products p
         LEFT JOIN (SELECT productId, COUNT(*) AS c, AVG(rating) AS a
                      FROM reviews
                     WHERE status = 'approved' AND deletedAt IS NULL
                     GROUP BY productId) r ON r.productId = p.id
          SET p.reviewCount = COALESCE(r.c, 0),
              p.reviewAverage = ROUND(COALESCE(r.a, 0), 2)`,
      { transaction },
    );
    await put(M.AuditLog, "audit", {
      actorId: owner.id,
      action: "demo.seed",
      resourceType: "development",
      metadata: {
        demo: true,
        description: "Added development fixtures across admin sections",
      },
    });
  });
  console.log(
    JSON.stringify(
      { message: "Demo seed completed", created: counts },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Demo seed failed");
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
