import {
  DataTypes,
  DynamicModel,
  initializeModel,
  primaryId,
} from "./shared.js";

/** @type {any} */
export class OrderConfirmation extends DynamicModel {}
initializeModel(
  OrderConfirmation,
  {
    id: primaryId(),
    method: {
      type: DataTypes.ENUM("call", "sms_link", "manual", "auto"),
      allowNull: false,
    },
    outcome: {
      type: DataTypes.ENUM(
        "confirmed",
        "no_answer",
        "wrong_number",
        "customer_cancelled",
        "call_back",
        "auto_cancelled",
      ),
      allowNull: false,
    },
    note: DataTypes.STRING(500),
    callbackAt: DataTypes.DATE,
  },
  {
    modelName: "OrderConfirmation",
    tableName: "order_confirmations",
    updatedAt: false,
  },
);

/** @type {any} */
export class MetaCapiEvent extends DynamicModel {}
initializeModel(
  MetaCapiEvent,
  {
    id: primaryId(),
    eventId: { type: DataTypes.STRING(120), allowNull: false, unique: true },
    eventName: { type: DataTypes.STRING(40), allowNull: false },
    eventTime: { type: DataTypes.DATE, allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    status: {
      type: DataTypes.ENUM("held", "pending", "processing", "sent", "failed"),
      allowNull: false,
      defaultValue: "pending",
    },
    attempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: false },
    leaseUntil: DataTypes.DATE,
    lastError: DataTypes.STRING(500),
    sentAt: DataTypes.DATE,
  },
  { modelName: "MetaCapiEvent", tableName: "meta_capi_events" },
);

/** @type {any} */
export class ManualPaymentClaim extends DynamicModel {}
initializeModel(
  ManualPaymentClaim,
  {
    id: primaryId(),
    provider: {
      type: DataTypes.ENUM("bkash", "nagad", "rocket", "upay"),
      allowNull: false,
    },
    senderPhone: { type: DataTypes.STRING(20), allowNull: false },
    trxId: { type: DataTypes.STRING(40), allowNull: false },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    status: {
      type: DataTypes.ENUM("submitted", "verified", "rejected", "expired"),
      allowNull: false,
      defaultValue: "submitted",
    },
    reviewedAt: DataTypes.DATE,
    rejectionReason: DataTypes.STRING(500),
    version: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 1,
    },
  },
  { modelName: "ManualPaymentClaim", tableName: "manual_payment_claims" },
);

/** @type {any} */
export class RiskBlocklist extends DynamicModel {}
initializeModel(
  RiskBlocklist,
  {
    id: primaryId(),
    type: {
      type: DataTypes.ENUM("phone", "email", "ip_prefix"),
      allowNull: false,
    },
    value: { type: DataTypes.STRING(190), allowNull: false },
    reason: { type: DataTypes.STRING(255), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    expiresAt: DataTypes.DATE,
  },
  { modelName: "RiskBlocklist", tableName: "risk_blocklist" },
);

/** @type {any} */
export class BdLocation extends DynamicModel {}
initializeModel(
  BdLocation,
  {
    id: primaryId(),
    code: { type: DataTypes.STRING(60), allowNull: false, unique: true },
    level: {
      type: DataTypes.ENUM("division", "district", "thana"),
      allowNull: false,
    },
    parentCode: DataTypes.STRING(60),
    nameEn: { type: DataTypes.STRING(120), allowNull: false },
    nameBn: { type: DataTypes.STRING(120), allowNull: false },
    zoneCode: DataTypes.STRING(60),
    displayOrder: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { modelName: "BdLocation", tableName: "bd_locations" },
);

/** @type {any} */
export class SearchSynonym extends DynamicModel {}
initializeModel(
  SearchSynonym,
  {
    id: primaryId(),
    term: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    synonyms: { type: DataTypes.JSON, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { modelName: "SearchSynonym", tableName: "search_synonyms" },
);

/** @type {any} */
export class SearchMiss extends DynamicModel {}
initializeModel(
  SearchMiss,
  {
    id: primaryId(),
    query: { type: DataTypes.STRING(80), allowNull: false },
    locale: { type: DataTypes.ENUM("en", "bn"), allowNull: false },
    count: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 1,
    },
    firstSeenAt: { type: DataTypes.DATE, allowNull: false },
    lastSeenAt: { type: DataTypes.DATE, allowNull: false },
  },
  { modelName: "SearchMiss", tableName: "search_misses", timestamps: false },
);
