import {
  DataTypes,
  DynamicModel,
  initializeModel,
  optimisticVersion,
  primaryId,
} from "./shared.js";

/** @type {any} */
export class StoreSetting extends DynamicModel {}
initializeModel(
  StoreSetting,
  {
    id: primaryId(),
    key: { type: DataTypes.STRING(100), unique: true, allowNull: false },
    value: { type: DataTypes.JSON, allowNull: false },
    isPublic: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    version: optimisticVersion(),
  },
  { modelName: "StoreSetting", tableName: "store_settings" },
);
/** @type {any} */
export class FeatureFlag extends DynamicModel {}
initializeModel(
  FeatureFlag,
  {
    id: primaryId(),
    key: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    config: DataTypes.JSON,
    version: optimisticVersion(),
  },
  { modelName: "FeatureFlag", tableName: "feature_flags" },
);

/** @type {any} */
export class Cart extends DynamicModel {}
initializeModel(
  Cart,
  {
    id: primaryId(),
    tokenHash: { type: DataTypes.CHAR(64), unique: true },
    status: {
      type: DataTypes.ENUM("active", "converted", "expired"),
      allowNull: false,
      defaultValue: "active",
    },
    version: optimisticVersion(),
    expiresAt: DataTypes.DATE,
  },
  { modelName: "Cart", tableName: "carts" },
);
/** @type {any} */
export class CartItem extends DynamicModel {}
initializeModel(
  CartItem,
  {
    id: primaryId(),
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    unitPriceSnapshot: DataTypes.DECIMAL(12, 2),
    metadata: DataTypes.JSON,
    version: optimisticVersion(),
  },
  {
    modelName: "CartItem",
    tableName: "cart_items",
    indexes: [{ unique: true, fields: ["cartId", "variantId"] }],
  },
);
/** @type {any} */
export class Coupon extends DynamicModel {}
initializeModel(
  Coupon,
  {
    id: primaryId(),
    code: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    type: {
      type: DataTypes.ENUM(
        "percentage",
        "fixed_cart",
        "fixed_item",
        "free_delivery",
      ),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    startsAt: DataTypes.DATE,
    endsAt: DataTypes.DATE,
    minimumSpend: DataTypes.DECIMAL(12, 2),
    maximumSpend: DataTypes.DECIMAL(12, 2),
    usageLimit: DataTypes.INTEGER.UNSIGNED,
    perCustomerLimit: DataTypes.INTEGER.UNSIGNED,
    perItemLimit: DataTypes.INTEGER.UNSIGNED,
    includeSaleItems: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    firstOrderOnly: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    stackable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    allowedZones: DataTypes.JSON,
    allowedPayments: DataTypes.JSON,
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    version: optimisticVersion(),
    deletedAt: DataTypes.DATE,
  },
  { modelName: "Coupon", tableName: "coupons", paranoid: true },
);
/** @type {any} */
export class CartCoupon extends DynamicModel {}
initializeModel(
  CartCoupon,
  {
    id: primaryId(),
    applicationOrder: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
  },
  { modelName: "CartCoupon", tableName: "cart_coupons" },
);
/** @type {any} */
export class CouponUsage extends DynamicModel {}
initializeModel(
  CouponUsage,
  {
    id: primaryId(),
    customerPhone: DataTypes.STRING(20),
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    status: {
      type: DataTypes.ENUM("reserved", "consumed", "released", "reversed"),
      allowNull: false,
    },
  },
  { modelName: "CouponUsage", tableName: "coupon_usages" },
);
/** @type {any} */
export class CouponProduct extends DynamicModel {}
initializeModel(
  CouponProduct,
  {},
  { modelName: "CouponProduct", tableName: "coupon_products" },
);
/** @type {any} */
export class CouponProductExclusion extends DynamicModel {}
initializeModel(
  CouponProductExclusion,
  {},
  {
    modelName: "CouponProductExclusion",
    tableName: "coupon_product_exclusions",
  },
);
/** @type {any} */
export class CouponCategory extends DynamicModel {}
initializeModel(
  CouponCategory,
  {},
  { modelName: "CouponCategory", tableName: "coupon_categories" },
);
/** @type {any} */
export class CouponCategoryExclusion extends DynamicModel {}
initializeModel(
  CouponCategoryExclusion,
  {},
  {
    modelName: "CouponCategoryExclusion",
    tableName: "coupon_category_exclusions",
  },
);
/** @type {any} */
export class CouponUser extends DynamicModel {}
initializeModel(
  CouponUser,
  {},
  { modelName: "CouponUser", tableName: "coupon_users" },
);
/** @type {any} */
export class CouponPhone extends DynamicModel {}
initializeModel(
  CouponPhone,
  { id: primaryId(), phone: { type: DataTypes.STRING(20), allowNull: false } },
  { modelName: "CouponPhone", tableName: "coupon_phones" },
);

/** @type {any} */
export class Order extends DynamicModel {}
initializeModel(
  Order,
  {
    id: primaryId(),
    reference: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    source: {
      type: DataTypes.ENUM("storefront", "admin"),
      allowNull: false,
      defaultValue: "storefront",
    },
    orderStatus: {
      type: DataTypes.ENUM(
        "draft",
        "pending_payment",
        "placed",
        "confirmed",
        "processing",
        "completed",
        "cancelled",
        "failed",
      ),
      allowNull: false,
    },
    paymentStatus: {
      type: DataTypes.ENUM(
        "unpaid",
        "pending",
        "paid",
        "failed",
        "cancelled",
        "partially_refunded",
        "refunded",
      ),
      allowNull: false,
    },
    fulfillmentStatus: {
      type: DataTypes.ENUM(
        "unfulfilled",
        "processing",
        "packed",
        "shipped",
        "out_for_delivery",
        "delivered",
        "returned_to_origin",
        "partially_returned",
        "returned",
      ),
      allowNull: false,
    },
    paymentMethod: { type: DataTypes.ENUM("cod", "bkash"), allowNull: false },
    channel: {
      type: DataTypes.ENUM(
        "web",
        "facebook",
        "instagram",
        "whatsapp",
        "phone",
        "walk_in",
        "other",
      ),
      allowNull: false,
      defaultValue: "web",
    },
    confirmationStatus: {
      type: DataTypes.ENUM(
        "not_required",
        "pending",
        "confirmed",
        "no_answer",
        "wrong_number",
        "customer_cancelled",
        "call_back",
      ),
      allowNull: false,
      defaultValue: "not_required",
    },
    confirmationAttempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    nextConfirmationAt: DataTypes.DATE,
    confirmedAt: DataTypes.DATE,
    riskLevel: {
      type: DataTypes.ENUM("low", "medium", "high", "blocked"),
      allowNull: false,
      defaultValue: "low",
    },
    riskScore: {
      type: DataTypes.SMALLINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    riskSignals: DataTypes.JSON,
    duplicateOfOrderId: DataTypes.CHAR(26),
    tags: DataTypes.JSON,
    attribution: DataTypes.JSON,
    customerName: { type: DataTypes.STRING(120), allowNull: false },
    customerPhone: { type: DataTypes.STRING(20), allowNull: false },
    customerEmail: DataTypes.STRING(190),
    address: { type: DataTypes.TEXT, allowNull: false },
    deliveryCode: { type: DataTypes.STRING(60), allowNull: false },
    deliveryLabel: { type: DataTypes.STRING(120), allowNull: false },
    subtotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    discountTotal: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    deliveryTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    taxTotal: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    grandTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    currency: {
      type: DataTypes.CHAR(3),
      allowNull: false,
      defaultValue: "BDT",
    },
    locale: {
      type: DataTypes.ENUM("en", "bn"),
      allowNull: false,
      defaultValue: "en",
    },
    note: DataTypes.TEXT,
    cancellationReason: DataTypes.STRING(255),
    placedAt: DataTypes.DATE,
    completedAt: DataTypes.DATE,
    cancelledAt: DataTypes.DATE,
    metadata: DataTypes.JSON,
    version: optimisticVersion(),
  },
  { modelName: "Order", tableName: "orders" },
);
/** @type {any} */
export class OrderItem extends DynamicModel {}
initializeModel(
  OrderItem,
  {
    id: primaryId(),
    productName: { type: DataTypes.STRING(220), allowNull: false },
    variantTitle: DataTypes.STRING(180),
    sku: { type: DataTypes.STRING(100), allowNull: false },
    attributes: { type: DataTypes.JSON, defaultValue: {} },
    regularPrice: DataTypes.DECIMAL(12, 2),
    salePrice: DataTypes.DECIMAL(12, 2),
    unitPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    unitCost: DataTypes.DECIMAL(12, 2),
    discountTotal: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    taxTotal: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    fulfilledQuantity: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    returnedQuantity: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    lineTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  },
  { modelName: "OrderItem", tableName: "order_items" },
);
/** @type {any} */
export class OrderAddress extends DynamicModel {}
initializeModel(
  OrderAddress,
  {
    id: primaryId(),
    type: { type: DataTypes.ENUM("shipping", "billing"), allowNull: false },
    recipientName: { type: DataTypes.STRING(120), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: false },
    addressLine: { type: DataTypes.STRING(500), allowNull: false },
    area: DataTypes.STRING(120),
    district: DataTypes.STRING(120),
    division: DataTypes.STRING(120),
    postcode: DataTypes.STRING(20),
    landmark: DataTypes.STRING(255),
    thana: DataTypes.STRING(120),
    locationCode: DataTypes.STRING(60),
    deliveryCode: DataTypes.STRING(60),
    snapshot: DataTypes.JSON,
  },
  { modelName: "OrderAddress", tableName: "order_addresses" },
);
/** @type {any} */
export class OrderEvent extends DynamicModel {}
initializeModel(
  OrderEvent,
  {
    id: primaryId(),
    type: { type: DataTypes.STRING(80), allowNull: false },
    fromStatus: DataTypes.STRING(60),
    toStatus: DataTypes.STRING(60),
    message: { type: DataTypes.STRING(255), allowNull: false },
    public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    metadata: DataTypes.JSON,
  },
  { modelName: "OrderEvent", tableName: "order_events", updatedAt: false },
);
/** @type {any} */
export class OrderNote extends DynamicModel {}
initializeModel(
  OrderNote,
  {
    id: primaryId(),
    visibility: {
      type: DataTypes.ENUM("internal", "customer"),
      allowNull: false,
      defaultValue: "internal",
    },
    message: { type: DataTypes.TEXT, allowNull: false },
  },
  { modelName: "OrderNote", tableName: "order_notes", updatedAt: false },
);
/** @type {any} */
export class IdempotencyRecord extends DynamicModel {}
initializeModel(
  IdempotencyRecord,
  {
    id: primaryId(),
    scope: { type: DataTypes.STRING(100), allowNull: false },
    key: { type: DataTypes.STRING(150), allowNull: false },
    actorKey: { type: DataTypes.STRING(150), allowNull: false },
    requestHash: { type: DataTypes.CHAR(64), allowNull: false },
    responseStatus: DataTypes.INTEGER,
    responseBody: DataTypes.JSON,
    expiresAt: DataTypes.DATE,
  },
  {
    modelName: "IdempotencyRecord",
    tableName: "idempotency_records",
    indexes: [{ unique: true, fields: ["scope", "key", "actorKey"] }],
  },
);
/** @type {any} */
export class CheckoutQuote extends DynamicModel {}
initializeModel(
  CheckoutQuote,
  {
    id: primaryId(),
    requestHash: { type: DataTypes.CHAR(64), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    totals: { type: DataTypes.JSON, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: DataTypes.DATE,
  },
  { modelName: "CheckoutQuote", tableName: "checkout_quotes" },
);

/** @type {any} */
export class Payment extends DynamicModel {}
initializeModel(
  Payment,
  {
    id: primaryId(),
    method: { type: DataTypes.ENUM("cod", "bkash"), allowNull: false },
    provider: DataTypes.STRING(80),
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    currency: {
      type: DataTypes.CHAR(3),
      allowNull: false,
      defaultValue: "BDT",
    },
    status: {
      type: DataTypes.ENUM(
        "unpaid",
        "pending",
        "paid",
        "failed",
        "cancelled",
        "partially_refunded",
        "refunded",
      ),
      allowNull: false,
    },
    providerTransactionId: { type: DataTypes.STRING(190), unique: true },
    reference: DataTypes.STRING(190),
    paidAt: DataTypes.DATE,
    failedAt: DataTypes.DATE,
    cancelledAt: DataTypes.DATE,
    version: optimisticVersion(),
    metadata: DataTypes.JSON,
  },
  { modelName: "Payment", tableName: "payments" },
);
/** @type {any} */
export class PaymentAttempt extends DynamicModel {}
initializeModel(
  PaymentAttempt,
  {
    id: primaryId(),
    idempotencyKey: { type: DataTypes.STRING(150), allowNull: false },
    recoveryTokenHash: { type: DataTypes.CHAR(64), allowNull: false },
    providerPaymentId: { type: DataTypes.STRING(190), unique: true },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    status: {
      type: DataTypes.ENUM(
        "created",
        "redirected",
        "executing",
        "succeeded",
        "failed",
        "cancelled",
        "expired",
      ),
      allowNull: false,
    },
    redirectUrl: DataTypes.STRING(1000),
    requestMetadata: DataTypes.JSON,
    responseMetadata: DataTypes.JSON,
    callbackState: DataTypes.JSON,
    expiresAt: DataTypes.DATE,
  },
  { modelName: "PaymentAttempt", tableName: "payment_attempts" },
);
/** @type {any} */
export class Refund extends DynamicModel {}
initializeModel(
  Refund,
  {
    id: primaryId(),
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    reason: { type: DataTypes.STRING(500), allowNull: false },
    method: { type: DataTypes.ENUM("manual", "bkash"), allowNull: false },
    providerRefundId: { type: DataTypes.STRING(190), unique: true },
    status: {
      type: DataTypes.ENUM(
        "pending",
        "processing",
        "completed",
        "failed",
        "cancelled",
      ),
      allowNull: false,
    },
    completedAt: DataTypes.DATE,
    idempotencyKey: { type: DataTypes.STRING(150), allowNull: false },
    metadata: DataTypes.JSON,
  },
  {
    modelName: "Refund",
    tableName: "refunds",
    indexes: [
      { unique: true, fields: ["paymentId", "idempotencyKey"] },
      { unique: true, fields: ["returnId"] },
    ],
  },
);

/** @type {any} */
export class ShippingZone extends DynamicModel {}
initializeModel(
  ShippingZone,
  {
    id: primaryId(),
    code: { type: DataTypes.STRING(60), allowNull: false, unique: true },
    nameEn: { type: DataTypes.STRING(160), allowNull: false },
    nameBn: { type: DataTypes.STRING(160), allowNull: false },
    matchMode: {
      type: DataTypes.ENUM("selector", "structured"),
      allowNull: false,
      defaultValue: "selector",
    },
    rules: DataTypes.JSON,
    priority: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    version: optimisticVersion(),
    deletedAt: DataTypes.DATE,
  },
  { modelName: "ShippingZone", tableName: "shipping_zones", paranoid: true },
);
/** @type {any} */
export class ShippingMethod extends DynamicModel {}
initializeModel(
  ShippingMethod,
  {
    id: primaryId(),
    code: { type: DataTypes.STRING(60), allowNull: false, unique: true },
    type: {
      type: DataTypes.ENUM("flat_rate", "free", "courier"),
      allowNull: false,
      defaultValue: "flat_rate",
    },
    labelEn: { type: DataTypes.STRING(160), allowNull: false },
    labelBn: { type: DataTypes.STRING(160), allowNull: false },
    flatRate: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    freeThreshold: DataTypes.DECIMAL(12, 2),
    allowedPayments: DataTypes.JSON,
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    displayOrder: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    version: optimisticVersion(),
    deletedAt: DataTypes.DATE,
  },
  {
    modelName: "ShippingMethod",
    tableName: "shipping_methods",
    paranoid: true,
  },
);
/** @type {any} */
export class Shipment extends DynamicModel {}
initializeModel(
  Shipment,
  {
    id: primaryId(),
    provider: DataTypes.STRING(100),
    courierName: DataTypes.STRING(160),
    consignmentId: DataTypes.STRING(190),
    trackingUrl: DataTypes.STRING(1000),
    fee: DataTypes.DECIMAL(12, 2),
    status: {
      type: DataTypes.ENUM(
        "draft",
        "created",
        "picked_up",
        "in_transit",
        "out_for_delivery",
        "delivered",
        "cancelled",
        "failed",
      ),
      allowNull: false,
      defaultValue: "draft",
    },
    shippedAt: DataTypes.DATE,
    deliveredAt: DataTypes.DATE,
    version: optimisticVersion(),
  },
  { modelName: "Shipment", tableName: "shipments" },
);
/** @type {any} */
export class ShipmentEvent extends DynamicModel {}
initializeModel(
  ShipmentEvent,
  {
    id: primaryId(),
    type: { type: DataTypes.STRING(100), allowNull: false },
    message: { type: DataTypes.STRING(500), allowNull: false },
    providerEventId: DataTypes.STRING(190),
    metadata: DataTypes.JSON,
  },
  {
    modelName: "ShipmentEvent",
    tableName: "shipment_events",
    updatedAt: false,
  },
);

/** @type {any} */
export class Wishlist extends DynamicModel {}
initializeModel(
  Wishlist,
  {
    id: primaryId(),
    tokenHash: { type: DataTypes.CHAR(64), unique: true },
    status: {
      type: DataTypes.ENUM("active", "merged", "expired"),
      allowNull: false,
      defaultValue: "active",
    },
    expiresAt: DataTypes.DATE,
  },
  { modelName: "Wishlist", tableName: "wishlists" },
);
/** @type {any} */
export class WishlistItem extends DynamicModel {}
initializeModel(
  WishlistItem,
  {
    id: primaryId(),
    itemKey: { type: DataTypes.STRING(80), allowNull: false },
  },
  { modelName: "WishlistItem", tableName: "wishlist_items" },
);
/** @type {any} */
export class Review extends DynamicModel {}
initializeModel(
  Review,
  {
    id: primaryId(),
    rating: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    title: DataTypes.STRING(180),
    body: { type: DataTypes.TEXT, allowNull: false },
    status: {
      type: DataTypes.ENUM("pending", "approved", "rejected", "spam"),
      allowNull: false,
      defaultValue: "pending",
    },
    verifiedPurchase: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    fit: DataTypes.ENUM("small", "true_to_size", "large"),
    moderationReason: DataTypes.STRING(500),
    moderatedAt: DataTypes.DATE,
    staffResponse: DataTypes.TEXT,
    respondedAt: DataTypes.DATE,
    version: optimisticVersion(),
    deletedAt: DataTypes.DATE,
  },
  { modelName: "Review", tableName: "reviews", paranoid: true },
);
/** @type {any} */
export class ReturnMedia extends DynamicModel {}
initializeModel(
  ReturnMedia,
  {
    displayOrder: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
  },
  { modelName: "ReturnMedia", tableName: "return_media" },
);
/** @type {any} */
export class ReturnRequest extends DynamicModel {}
initializeModel(
  ReturnRequest,
  {
    id: primaryId(),
    reference: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    type: { type: DataTypes.ENUM("return", "exchange"), allowNull: false },
    status: {
      type: DataTypes.ENUM(
        "requested",
        "under_review",
        "approved",
        "rejected",
        "in_transit",
        "received",
        "completed",
        "cancelled",
      ),
      allowNull: false,
    },
    reason: { type: DataTypes.STRING(255), allowNull: false },
    customerNote: DataTypes.TEXT,
    resolution: {
      type: DataTypes.ENUM("refund", "exchange"),
      allowNull: false,
    },
    refundAmount: DataTypes.DECIMAL(12, 2),
    rejectionReason: DataTypes.STRING(500),
    requestedAt: { type: DataTypes.DATE, allowNull: false },
    approvedAt: DataTypes.DATE,
    rejectedAt: DataTypes.DATE,
    receivedAt: DataTypes.DATE,
    completedAt: DataTypes.DATE,
    cancelledAt: DataTypes.DATE,
    policySnapshot: DataTypes.JSON,
    version: optimisticVersion(),
  },
  { modelName: "ReturnRequest", tableName: "return_requests" },
);
/** @type {any} */
export class ReturnItem extends DynamicModel {}
initializeModel(
  ReturnItem,
  {
    id: primaryId(),
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    reason: { type: DataTypes.STRING(255), allowNull: false },
    condition: DataTypes.STRING(120),
    resolution: {
      type: DataTypes.ENUM("refund", "exchange"),
      allowNull: false,
    },
    restock: DataTypes.BOOLEAN,
    inspectionNote: DataTypes.STRING(500),
    restockedAt: DataTypes.DATE,
    requestedVariantId: DataTypes.CHAR(26),
  },
  { modelName: "ReturnItem", tableName: "return_items" },
);
/** @type {any} */
export class ReturnEvent extends DynamicModel {}
initializeModel(
  ReturnEvent,
  {
    id: primaryId(),
    type: { type: DataTypes.STRING(100), allowNull: false },
    message: { type: DataTypes.STRING(500), allowNull: false },
    public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    metadata: DataTypes.JSON,
  },
  { modelName: "ReturnEvent", tableName: "return_events", updatedAt: false },
);
