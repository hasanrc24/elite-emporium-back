import {
  DataTypes,
  DynamicModel,
  initializeModel,
  optimisticVersion,
  primaryId,
} from "./shared.js";

/** @type {any} */
export class User extends DynamicModel {}
initializeModel(
  User,
  {
    id: primaryId(),
    name: { type: DataTypes.STRING(120), allowNull: false },
    phone: { type: DataTypes.STRING(20), unique: true },
    email: { type: DataTypes.STRING(190), unique: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    status: {
      type: DataTypes.ENUM("active", "disabled"),
      allowNull: false,
      defaultValue: "active",
    },
    locale: {
      type: DataTypes.ENUM("en", "bn"),
      allowNull: false,
      defaultValue: "en",
    },
    phoneVerifiedAt: DataTypes.DATE,
    emailVerifiedAt: DataTypes.DATE,
    lastLoginAt: DataTypes.DATE,
    roleVersion: optimisticVersion(),
    mustChangePassword: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    riskLevel: {
      type: DataTypes.ENUM("normal", "review", "blocked"),
      allowNull: false,
      defaultValue: "normal",
    },
    version: optimisticVersion(),
    deletedAt: DataTypes.DATE,
  },
  { modelName: "User", tableName: "users", paranoid: true },
);

/** @type {any} */
export class Role extends DynamicModel {}
initializeModel(
  Role,
  {
    id: primaryId(),
    key: { type: DataTypes.STRING(60), unique: true, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    protected: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    version: optimisticVersion(),
  },
  { modelName: "Role", tableName: "roles" },
);

/** @type {any} */
export class Permission extends DynamicModel {}
initializeModel(
  Permission,
  {
    id: primaryId(),
    key: { type: DataTypes.STRING(100), unique: true, allowNull: false },
    module: {
      type: DataTypes.STRING(80),
      allowNull: false,
      defaultValue: "general",
    },
    description: DataTypes.STRING(255),
  },
  { modelName: "Permission", tableName: "permissions" },
);

/** @type {any} */
export class UserPermissionOverride extends DynamicModel {}
initializeModel(
  UserPermissionOverride,
  {
    id: primaryId(),
    allow: { type: DataTypes.BOOLEAN, allowNull: false },
    reason: { type: DataTypes.STRING(255), allowNull: false },
  },
  {
    modelName: "UserPermissionOverride",
    tableName: "user_permission_overrides",
  },
);

/** @type {any} */
export class AuthSession extends DynamicModel {}
initializeModel(
  AuthSession,
  {
    id: primaryId(),
    familyId: { type: DataTypes.CHAR(26), allowNull: false, unique: true },
    currentJtiHash: { type: DataTypes.CHAR(64), allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    lastUsedAt: { type: DataTypes.DATE, allowNull: false },
    userAgent: DataTypes.STRING(255),
    ipAddress: DataTypes.STRING(64),
    revokedAt: DataTypes.DATE,
    revokeReason: DataTypes.STRING(120),
  },
  { modelName: "AuthSession", tableName: "auth_sessions" },
);

/** @type {any} */
export class VerificationToken extends DynamicModel {}
initializeModel(
  VerificationToken,
  {
    id: primaryId(),
    channel: { type: DataTypes.ENUM("phone", "email"), allowNull: false },
    purpose: {
      type: DataTypes.ENUM("verify", "identity_change"),
      allowNull: false,
    },
    target: { type: DataTypes.STRING(190), allowNull: false },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    attempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    sentAt: DataTypes.DATE,
    consumedAt: DataTypes.DATE,
  },
  { modelName: "VerificationToken", tableName: "verification_tokens" },
);

/** @type {any} */
export class PasswordResetToken extends DynamicModel {}
initializeModel(
  PasswordResetToken,
  {
    id: primaryId(),
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: DataTypes.DATE,
    requestedIp: DataTypes.STRING(64),
    requestedUserAgent: DataTypes.STRING(255),
  },
  { modelName: "PasswordResetToken", tableName: "password_reset_tokens" },
);

/** @type {any} */
export class AuthChallenge extends DynamicModel {}
initializeModel(
  AuthChallenge,
  {
    id: primaryId(),
    type: { type: DataTypes.ENUM("mfa_login"), allowNull: false },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    rememberMe: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    attempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    consumedAt: DataTypes.DATE,
    userAgent: DataTypes.STRING(255),
    ipAddress: DataTypes.STRING(64),
  },
  { modelName: "AuthChallenge", tableName: "auth_challenges" },
);

/** @type {any} */
export class MfaMethod extends DynamicModel {}
initializeModel(
  MfaMethod,
  {
    id: primaryId(),
    type: { type: DataTypes.ENUM("totp"), allowNull: false },
    encryptedSecret: { type: DataTypes.TEXT, allowNull: false },
    label: DataTypes.STRING(120),
    confirmedAt: DataTypes.DATE,
    disabledAt: DataTypes.DATE,
  },
  { modelName: "MfaMethod", tableName: "mfa_methods" },
);

/** @type {any} */
export class MfaRecoveryCode extends DynamicModel {}
initializeModel(
  MfaRecoveryCode,
  {
    id: primaryId(),
    codeHash: { type: DataTypes.CHAR(64), allowNull: false },
    consumedAt: DataTypes.DATE,
  },
  {
    modelName: "MfaRecoveryCode",
    tableName: "mfa_recovery_codes",
    updatedAt: false,
  },
);

/** @type {any} */
export class UserAddress extends DynamicModel {}
initializeModel(
  UserAddress,
  {
    id: primaryId(),
    label: { type: DataTypes.STRING(80), allowNull: false },
    recipientName: { type: DataTypes.STRING(120), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: false },
    addressLine: { type: DataTypes.STRING(500), allowNull: false },
    area: DataTypes.STRING(120),
    district: DataTypes.STRING(120),
    division: DataTypes.STRING(120),
    postcode: DataTypes.STRING(20),
    landmark: DataTypes.STRING(255),
    isDefaultShipping: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isDefaultBilling: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    version: optimisticVersion(),
    deletedAt: DataTypes.DATE,
  },
  { modelName: "UserAddress", tableName: "user_addresses", paranoid: true },
);

/** @type {any} */
export class CustomerNote extends DynamicModel {}
initializeModel(
  CustomerNote,
  {
    id: primaryId(),
    category: {
      type: DataTypes.ENUM("support", "risk", "operations"),
      allowNull: false,
      defaultValue: "support",
    },
    message: { type: DataTypes.TEXT, allowNull: false },
  },
  { modelName: "CustomerNote", tableName: "customer_notes", updatedAt: false },
);

/** @type {any} */
export class PrivacyRequest extends DynamicModel {}
initializeModel(
  PrivacyRequest,
  {
    id: primaryId(),
    type: { type: DataTypes.ENUM("export", "deletion"), allowNull: false },
    status: {
      type: DataTypes.ENUM(
        "requested",
        "under_review",
        "approved",
        "rejected",
        "completed",
      ),
      allowNull: false,
      defaultValue: "requested",
    },
    activeKey: { type: DataTypes.STRING(80), unique: true },
    requestedAt: { type: DataTypes.DATE, allowNull: false },
    reviewedAt: DataTypes.DATE,
    completedAt: DataTypes.DATE,
    reason: DataTypes.STRING(500),
    metadata: DataTypes.JSON,
    version: optimisticVersion(),
  },
  { modelName: "PrivacyRequest", tableName: "privacy_requests" },
);
