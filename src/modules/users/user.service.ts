import argon2 from "argon2";
import { Op } from "sequelize";
import { AuthSession, User, UserAddress } from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { normalizeEmail, normalizePhone } from "../../lib/normalization.js";
import { recordAudit } from "../audits/audit.service.js";
import { publicUser, queueVerification } from "../auth/auth.service.js";
import { userAuthInclude } from "../auth/authorization.js";

const addressFields: RuntimeValue = [
  "label",
  "recipientName",
  "phone",
  "addressLine",
  "area",
  "district",
  "division",
  "postcode",
  "landmark",
  "isDefaultShipping",
  "isDefaultBilling",
];

function addressDto(address: RuntimeValue) {
  return Object.fromEntries(
    ["id", ...addressFields, "version", "createdAt", "updatedAt"].map(
      (key: RuntimeValue) => [key, address[key]],
    ),
  );
}

export async function updateProfile(
  userId: RuntimeValue,
  currentSessionId: RuntimeValue,
  payload: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const user: RuntimeValue = await User.findByPk(userId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) throw AppError.notFound("User not found.");
    if (Number(payload.version) !== Number(user.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "Your profile changed in another session. Refresh and review the latest version.",
      );
    const nextPhone: RuntimeValue =
      payload.phone === undefined ? user.phone : normalizePhone(payload.phone);
    const nextEmail: RuntimeValue =
      payload.email === undefined ? user.email : normalizeEmail(payload.email);
    if (payload.phone && !nextPhone)
      throw AppError.unprocessable(
        "INVALID_PHONE",
        "Enter a valid Bangladeshi phone number.",
        { phone: ["Enter a valid Bangladeshi phone number."] },
      );
    if (!nextPhone && !nextEmail)
      throw AppError.unprocessable(
        "IDENTIFIER_REQUIRED",
        "Keep at least one phone number or email on your account.",
      );
    const identityChanged =
      nextPhone !== user.phone || nextEmail !== user.email;
    if (
      identityChanged &&
      (!payload.currentPassword ||
        !(await argon2.verify(user.passwordHash, payload.currentPassword)))
    )
      throw AppError.unprocessable(
        "REAUTHENTICATION_REQUIRED",
        "Enter your current password to change phone or email.",
        { currentPassword: ["Your current password is required."] },
      );
    if (identityChanged) {
      const duplicate: RuntimeValue = await User.findOne({
        where: {
          id: { [Op.ne]: userId },
          [Op.or]: [
            nextPhone && { phone: nextPhone },
            nextEmail && { email: nextEmail },
          ].filter(Boolean),
        },
        paranoid: false,
        transaction,
      });
      if (duplicate)
        throw AppError.conflict(
          "IDENTIFIER_IN_USE",
          "That phone number or email is already in use.",
        );
    }
    const before: RuntimeValue = {
      name: user.name,
      phone: user.phone,
      email: user.email,
      locale: user.locale,
      version: user.version,
    };
    if (payload.name !== undefined) user.name = payload.name;
    if (payload.locale !== undefined) user.locale = payload.locale;
    if (nextPhone !== user.phone) {
      user.phone = nextPhone;
      user.phoneVerifiedAt = null;
    }
    if (nextEmail !== user.email) {
      user.email = nextEmail;
      user.emailVerifiedAt = null;
    }
    user.version += 1;
    await user.save({ transaction });
    if (identityChanged) {
      await AuthSession.update(
        { revokedAt: new Date(), revokeReason: "identity_changed" },
        {
          where: { userId, id: { [Op.ne]: currentSessionId }, revokedAt: null },
          transaction,
        },
      );
      if (nextPhone !== before.phone && nextPhone)
        await queueVerification(user, "phone", transaction);
      if (nextEmail !== before.email && nextEmail)
        await queueVerification(user, "email", transaction);
    }
    await recordAudit({
      actorId: userId,
      action: "user.profile_update",
      resourceType: "user",
      resourceId: userId,
      before,
      after: {
        name: user.name,
        phone: user.phone,
        email: user.email,
        locale: user.locale,
        version: user.version,
      },
      request,
      transaction,
    });
    const hydrated: RuntimeValue = await User.findByPk(userId, {
      include: userAuthInclude,
      transaction,
    });
    return publicUser(hydrated);
  });
}

async function normalizeAddress(payload: RuntimeValue) {
  const phone: RuntimeValue = normalizePhone(payload.phone);
  if (!phone)
    throw AppError.unprocessable(
      "INVALID_PHONE",
      "Enter a valid Bangladeshi phone number.",
      { phone: ["Enter a valid Bangladeshi phone number."] },
    );
  return {
    ...Object.fromEntries(
      addressFields.map((key: RuntimeValue) => [key, payload[key] ?? null]),
    ),
    phone,
    isDefaultShipping: Boolean(payload.isDefaultShipping),
    isDefaultBilling: Boolean(payload.isDefaultBilling),
  };
}

async function clearOtherDefaults(
  userId: RuntimeValue,
  addressId: RuntimeValue,
  values: RuntimeValue,
  transaction: RuntimeValue,
) {
  if (values.isDefaultShipping)
    await UserAddress.update(
      { isDefaultShipping: false },
      {
        where: { userId, id: { [Op.ne]: addressId }, isDefaultShipping: true },
        transaction,
      },
    );
  if (values.isDefaultBilling)
    await UserAddress.update(
      { isDefaultBilling: false },
      {
        where: { userId, id: { [Op.ne]: addressId }, isDefaultBilling: true },
        transaction,
      },
    );
}

export async function listAddresses(userId: RuntimeValue) {
  const addresses: RuntimeValue = await UserAddress.findAll({
    where: { userId },
    order: [
      ["isDefaultShipping", "DESC"],
      ["createdAt", "DESC"],
    ],
  });
  return addresses.map(addressDto);
}

export async function createAddress(
  userId: RuntimeValue,
  payload: RuntimeValue,
  request: RuntimeValue,
) {
  const values: RuntimeValue = await normalizeAddress(payload);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const count: RuntimeValue = await UserAddress.count({
      where: { userId },
      transaction,
    });
    if (count >= 20)
      throw AppError.unprocessable(
        "ADDRESS_LIMIT_REACHED",
        "You can save up to 20 addresses.",
      );
    if (count === 0) {
      values.isDefaultShipping = true;
      values.isDefaultBilling = true;
    }
    const address: RuntimeValue = await UserAddress.create(
      { id: newId(), userId, ...values, version: 1 },
      { transaction },
    );
    await clearOtherDefaults(userId, address.id, values, transaction);
    await recordAudit({
      actorId: userId,
      action: "user.address_create",
      resourceType: "user_address",
      resourceId: address.id,
      after: addressDto(address),
      request,
      transaction,
    });
    return addressDto(address);
  });
}

export async function updateAddress(
  userId: RuntimeValue,
  addressId: RuntimeValue,
  payload: RuntimeValue,
  request: RuntimeValue,
) {
  const values: RuntimeValue = await normalizeAddress(payload);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const address: RuntimeValue = await UserAddress.findOne({
      where: { id: addressId, userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!address) throw AppError.notFound("Address not found.");
    if (Number(payload.version) !== Number(address.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This address changed in another session. Refresh and review the latest version.",
      );
    const before: RuntimeValue = addressDto(address);
    Object.assign(address, values, { version: address.version + 1 });
    await address.save({ transaction });
    await clearOtherDefaults(userId, address.id, values, transaction);
    await recordAudit({
      actorId: userId,
      action: "user.address_update",
      resourceType: "user_address",
      resourceId: address.id,
      before,
      after: addressDto(address),
      request,
      transaction,
    });
    return addressDto(address);
  });
}

export async function deleteAddress(
  userId: RuntimeValue,
  addressId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const address: RuntimeValue = await UserAddress.findOne({
      where: { id: addressId, userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!address) throw AppError.notFound("Address not found.");
    await recordAudit({
      actorId: userId,
      action: "user.address_delete",
      resourceType: "user_address",
      resourceId: address.id,
      before: addressDto(address),
      request,
      transaction,
    });
    await address.destroy({ transaction });
  });
}
