import {
  Cart,
  CartCoupon,
  CartItem,
  Coupon,
  InventoryLevel,
  MediaAsset,
  Product,
  ProductMedia,
  ProductTranslation,
  ProductVariant,
} from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../lib/errors.js';
import { newId, randomToken } from '../../lib/ids.js';
import { sha256 } from '../../lib/crypto.js';
import { lineTotal, money, moneyString } from '../../lib/money.js';
import { mediaPublicUrl } from '../media/media.storage.js';
import { calculatePromotions, couponInclude } from '../promotions/promotion.service.js';
import { effectivePrice, isSaleActive } from '../catalog/pricing.js';

export const CART_COOKIE = 'ee_cart';

const itemInclude = [{
  model: ProductVariant,
  as: 'variant',
  paranoid: false,
  include: [
    { model: InventoryLevel, as: 'inventoryLevels' },
    {
      model: Product,
      as: 'product',
      paranoid: false,
      include: [
        { model: ProductTranslation, as: 'translations' },
        { model: ProductMedia, as: 'media', where: { role: 'primary' }, required: false, include: [{ model: MediaAsset, as: 'asset', where: { status: 'ready', privacy: 'public' }, required: false }] },
      ],
    },
  ],
}];
const cartInclude = [
  { model: CartItem, as: 'items', include: itemInclude },
  { model: Coupon, as: 'coupons', through: { attributes: ['applicationOrder'] }, include: couponInclude },
];

function availableQuantity(variant) {
  return (variant.inventoryLevels || []).reduce((total, level) => total + Math.max(0, Number(level.onHand) - Number(level.reserved)), 0);
}

export async function resolveCart(token, userId, create = true) {
  const where = userId ? { userId, status: 'active' } : token ? { tokenHash: sha256(token), status: 'active' } : null;
  let cart = where ? await Cart.findOne({ where }) : null;
  let issuedToken = null;
  if (!cart && create) {
    if (!userId) issuedToken = token || randomToken();
    cart = await Cart.create({ id: newId(), userId: userId || null, tokenHash: userId ? null : sha256(issuedToken), status: 'active', expiresAt: userId ? null : new Date(Date.now() + 30 * 86400000), version: 1 });
  }
  return { cart, issuedToken };
}

export async function loadCart(cartId, transaction = null, lock = null) {
  return Cart.findByPk(cartId, { include: cartInclude, transaction, lock });
}

export async function serializeCart(cart, locale = 'en', userId = null) {
  const notices = [];
  const promotionLines = [];
  const items = (cart.items || []).map((item) => {
    const variant = item.variant;
    const product = variant?.product;
    const translation = product?.translations?.find((value) => value.locale === locale) || product?.translations?.find((value) => value.locale === 'en');
    const fallback = item.metadata || {};
    const reasons = [];
    if (!variant || variant.deletedAt || !variant.active || variant.status !== 'active') reasons.push('VARIANT_UNAVAILABLE');
    if (!product || product.deletedAt || product.status !== 'published') reasons.push('PRODUCT_UNAVAILABLE');
    const available = variant ? availableQuantity(variant) : 0;
    if (variant?.stockPolicy === 'deny' && item.quantity > available) reasons.push(available ? 'QUANTITY_EXCEEDS_STOCK' : 'OUT_OF_STOCK');
    const unit = variant ? effectivePrice(variant) : money(item.unitPriceSnapshot || 0);
    const changed = item.unitPriceSnapshot != null && !money(item.unitPriceSnapshot).equals(unit);
    if (changed) reasons.push('PRICE_CHANGED');
    const primary = product?.media?.find((media) => media.asset)?.asset;
    const purchasable = !reasons.some((reason) => ['VARIANT_UNAVAILABLE', 'PRODUCT_UNAVAILABLE', 'OUT_OF_STOCK', 'QUANTITY_EXCEEDS_STOCK'].includes(reason));
    const dto = {
      id: item.id,
      quantity: item.quantity,
      variantId: variant?.id || item.variantId,
      sku: variant?.sku || fallback.sku || '',
      variantTitle: variant?.title || fallback.variantTitle || '',
      attributes: variant?.attributes || fallback.attributes || {},
      product: { id: product?.id || fallback.productId || null, slug: product?.slug || fallback.productSlug || '', name: translation?.name || fallback.productName || '' },
      image: primary ? { url: mediaPublicUrl(primary.storageKey), alt: primary.altText || translation?.name || '' } : null,
      unitPrice: moneyString(unit),
      previousUnitPrice: changed ? moneyString(item.unitPriceSnapshot) : null,
      lineTotal: moneyString(lineTotal(unit, item.quantity)),
      available,
      stockPolicy: variant?.stockPolicy || 'deny',
      onSale: variant ? isSaleActive(variant) : false,
      purchasable,
      notices: reasons,
      version: item.version,
    };
    if (reasons.length) notices.push({ itemId: item.id, codes: reasons });
    if (purchasable) promotionLines.push({ id: item.id, productId: product.id, categoryId: product.categoryId, quantity: item.quantity, unitPrice: unit, total: lineTotal(unit, item.quantity), onSale: dto.onSale });
    return dto;
  });
  const subtotal = promotionLines.reduce((sum, item) => sum.plus(item.total), money(0));
  let promotions = { coupons: [], lineDiscounts: {}, itemDiscountTotal: '0.00', deliveryDiscount: '0.00', discountTotal: '0.00' };
  let couponIssue = null;
  if (cart.coupons?.length) {
    try { promotions = await calculatePromotions({ coupons: cart.coupons, lines: promotionLines, subtotal, deliveryTotal: 0, userId }); }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      couponIssue = { code: error.code, message: error.message };
      notices.push({ code: error.code, scope: 'coupon' });
    }
  }
  const discount = money(promotions.itemDiscountTotal);
  return {
    id: cart.id,
    version: cart.version,
    status: cart.status,
    items: items.map((item) => ({ ...item, discountTotal: promotions.lineDiscounts[item.id] || '0.00', discountedLineTotal: moneyString(money(item.lineTotal).minus(promotions.lineDiscounts[item.id] || 0)) })),
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    coupons: promotions.coupons,
    couponIssue,
    notices,
    totals: { subtotal: moneyString(subtotal), discount: moneyString(discount), total: moneyString(subtotal.minus(discount)) },
  };
}

export async function getCart(cartId, locale, userId = null) {
  const cart = await loadCart(cartId);
  if (!cart) throw AppError.notFound('Cart not found.');
  return serializeCart(cart, locale, userId);
}

async function loadPurchasableVariant(variantId, transaction, lock = false) {
  const variant = await ProductVariant.findOne({
    where: { id: variantId, active: true, status: 'active' },
    include: [{ model: Product, as: 'product', where: { status: 'published' }, include: [{ model: ProductTranslation, as: 'translations' }] }, { model: InventoryLevel, as: 'inventoryLevels' }],
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!variant) throw AppError.notFound('Product variant not found.');
  return variant;
}

export async function addItem(cartId, payload) {
  await sequelize.transaction(async (transaction) => {
    const cart = await Cart.findOne({ where: { id: cartId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!cart) throw AppError.unprocessable('CART_UNAVAILABLE', 'Your cart is no longer active.');
    const variant = await loadPurchasableVariant(payload.variantId, transaction);
    const [item] = await CartItem.findOrCreate({ where: { cartId, variantId: variant.id }, defaults: { id: newId(), cartId, variantId: variant.id, quantity: 0, version: 1 }, transaction });
    await item.reload({ transaction, lock: transaction.LOCK.UPDATE });
    const nextQuantity = Number(item.quantity) + payload.quantity;
    const available = availableQuantity(variant);
    if (nextQuantity > 99) throw AppError.unprocessable('CART_QUANTITY_LIMIT', 'You can add up to 99 of one item.');
    if (variant.stockPolicy === 'deny' && nextQuantity > available) throw AppError.unprocessable('INSUFFICIENT_STOCK', `Only ${available} item(s) are available.`);
    const translation = variant.product.translations.find((value) => value.locale === 'en') || variant.product.translations[0];
    item.quantity = nextQuantity;
    item.unitPriceSnapshot = moneyString(effectivePrice(variant));
    item.metadata = { productId: variant.product.id, productSlug: variant.product.slug, productName: translation?.name || '', sku: variant.sku, variantTitle: variant.title, attributes: variant.attributes };
    item.version += 1;
    await item.save({ transaction });
    cart.version += 1;
    await cart.save({ transaction });
  });
}

export async function updateItem(cartId, itemId, quantity, expectedVersion = null) {
  await sequelize.transaction(async (transaction) => {
    const cart = await Cart.findOne({ where: { id: cartId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    const item = await CartItem.findOne({ where: { id: itemId, cartId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!cart || !item) throw AppError.notFound('Cart item not found.');
    if (expectedVersion != null && Number(expectedVersion) !== Number(item.version)) throw AppError.conflict('VERSION_CONFLICT', 'This cart item changed. Refresh and try again.');
    if (quantity === 0) await item.destroy({ transaction });
    else {
      const variant = await loadPurchasableVariant(item.variantId, transaction);
      const available = availableQuantity(variant);
      if (variant.stockPolicy === 'deny' && quantity > available) throw AppError.unprocessable('INSUFFICIENT_STOCK', `Only ${available} item(s) are available.`);
      item.quantity = quantity;
      item.unitPriceSnapshot = moneyString(effectivePrice(variant));
      item.version += 1;
      await item.save({ transaction });
    }
    cart.version += 1;
    await cart.save({ transaction });
  });
}

export async function removeItem(cartId, itemId) {
  await sequelize.transaction(async (transaction) => {
    const cart = await Cart.findOne({ where: { id: cartId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!cart) throw AppError.notFound('Cart not found.');
    const deleted = await CartItem.destroy({ where: { id: itemId, cartId }, transaction });
    if (!deleted) throw AppError.notFound('Cart item not found.');
    cart.version += 1;
    await cart.save({ transaction });
  });
}

export async function applyCoupon(cartId, code, userId = null) {
  await sequelize.transaction(async (transaction) => {
    const cart = await Cart.findOne({ where: { id: cartId, status: 'active' }, include: cartInclude, transaction, lock: transaction.LOCK.UPDATE });
    if (!cart) throw AppError.notFound('Cart not found.');
    const coupon = await Coupon.findOne({ where: { code: String(code).trim().toUpperCase() }, include: couponInclude, transaction, lock: transaction.LOCK.SHARE });
    if (!coupon) throw AppError.unprocessable('COUPON_INVALID', 'Enter a valid coupon code.', { code: ['Enter a valid coupon code.'] });
    if (cart.coupons.some((item) => item.id === coupon.id)) throw AppError.conflict('COUPON_ALREADY_APPLIED', 'This coupon is already applied.');
    const dto = await serializeCart({ ...cart.get(), coupons: [...cart.coupons, coupon] }, 'en', userId);
    if (dto.couponIssue) throw AppError.unprocessable(dto.couponIssue.code, dto.couponIssue.message);
    await CartCoupon.create({ id: newId(), cartId, couponId: coupon.id, applicationOrder: cart.coupons.length }, { transaction });
    cart.version += 1;
    await cart.save({ transaction });
  });
}

export async function removeCoupon(cartId, code) {
  await sequelize.transaction(async (transaction) => {
    const cart = await Cart.findOne({ where: { id: cartId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!cart) throw AppError.notFound('Cart not found.');
    const coupon = await Coupon.findOne({ where: { code: String(code).trim().toUpperCase() }, transaction });
    const removed = coupon && await CartCoupon.destroy({ where: { cartId, couponId: coupon.id }, transaction });
    if (!removed) throw AppError.notFound('Applied coupon not found.');
    cart.version += 1;
    await cart.save({ transaction });
  });
}

export async function mergeGuestCart(userCartId, guestToken) {
  if (!guestToken) return { changes: [] };
  return sequelize.transaction(async (transaction) => {
    const carts = await Cart.findAll({ where: { id: userCartId }, transaction, lock: transaction.LOCK.UPDATE });
    const userCart = carts[0];
    const guestCart = await Cart.findOne({ where: { tokenHash: sha256(guestToken), status: 'active', userId: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (!userCart || !guestCart || guestCart.id === userCart.id) return { changes: [] };
    const guestItems = await CartItem.findAll({ where: { cartId: guestCart.id }, transaction, lock: transaction.LOCK.UPDATE });
    const changes = [];
    for (const guestItem of guestItems) {
      let target = await CartItem.findOne({ where: { cartId: userCart.id, variantId: guestItem.variantId }, transaction, lock: transaction.LOCK.UPDATE });
      const variant = await loadPurchasableVariant(guestItem.variantId, transaction).catch(() => null);
      if (!variant) { changes.push({ variantId: guestItem.variantId, code: 'ITEM_UNAVAILABLE' }); continue; }
      const requested = Number(target?.quantity || 0) + Number(guestItem.quantity);
      const maximum = variant.stockPolicy === 'deny' ? Math.min(99, availableQuantity(variant)) : 99;
      const quantity = Math.min(requested, maximum);
      if (quantity <= 0) { changes.push({ variantId: variant.id, code: 'OUT_OF_STOCK' }); continue; }
      if (!target) target = await CartItem.create({ id: newId(), cartId: userCart.id, variantId: variant.id, quantity, unitPriceSnapshot: moneyString(effectivePrice(variant)), metadata: guestItem.metadata, version: 1 }, { transaction });
      else { target.quantity = quantity; target.unitPriceSnapshot = moneyString(effectivePrice(variant)); target.version += 1; await target.save({ transaction }); }
      if (quantity !== requested) changes.push({ variantId: variant.id, code: 'QUANTITY_ADJUSTED', requested, quantity });
    }
    const guestCoupons = await CartCoupon.findAll({ where: { cartId: guestCart.id }, transaction });
    const targetCoupons = await CartCoupon.count({ where: { cartId: userCart.id }, transaction });
    if (!targetCoupons && guestCoupons.length === 1) await CartCoupon.create({ id: newId(), cartId: userCart.id, couponId: guestCoupons[0].couponId, applicationOrder: 0 }, { transaction });
    else if (guestCoupons.length) changes.push({ code: 'COUPONS_REVIEW_REQUIRED' });
    guestCart.status = 'expired';
    await guestCart.save({ transaction });
    userCart.version += 1;
    await userCart.save({ transaction });
    return { changes };
  });
}
