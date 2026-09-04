import { Wishlist, WishlistItem, Product, ProductTranslation, ProductVariant, InventoryLevel, ProductMedia, MediaAsset } from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../lib/errors.js';
import { newId, randomToken } from '../../lib/ids.js';
import { sha256 } from '../../lib/crypto.js';
import { moneyString } from '../../lib/money.js';
import { effectivePrice } from '../catalog/pricing.js';
import { mediaPublicUrl } from '../media/media.storage.js';

export const WISHLIST_COOKIE = 'ee_wishlist';
const itemInclude = [
  { model: Product, as: 'product', paranoid: false, include: [{ model: ProductTranslation, as: 'translations' }, { model: ProductMedia, as: 'media', where: { role: 'primary' }, required: false, include: [{ model: MediaAsset, as: 'asset', where: { status: 'ready', privacy: 'public' }, required: false }] }] },
  { model: ProductVariant, as: 'variant', paranoid: false, include: [{ model: InventoryLevel, as: 'inventoryLevels' }] },
];

export async function resolveWishlist(token, userId, create = true) {
  const where = userId ? { userId, status: 'active' } : token ? { tokenHash: sha256(token), status: 'active' } : null;
  let wishlist = where ? await Wishlist.findOne({ where }) : null;
  let issuedToken = null;
  if (!wishlist && create) {
    if (!userId) issuedToken = token || randomToken();
    wishlist = await Wishlist.create({ id: newId(), userId: userId || null, tokenHash: userId ? null : sha256(issuedToken), status: 'active', expiresAt: userId ? null : new Date(Date.now() + 90 * 86400000) });
  }
  return { wishlist, issuedToken };
}

function itemDto(item, locale) {
  const product = item.product;
  const variant = item.variant;
  const translation = product?.translations?.find((row) => row.locale === locale) || product?.translations?.find((row) => row.locale === 'en');
  const available = variant ? variant.inventoryLevels.reduce((total, level) => total + Math.max(0, Number(level.onHand) - Number(level.reserved)), 0) : 0;
  const media = product?.media?.find((row) => row.asset)?.asset;
  return { id: item.id, product: product ? { id: product.id, slug: product.slug, name: translation?.name || product.slug, status: product.status } : null, variant: variant ? { id: variant.id, sku: variant.sku, title: variant.title, attributes: variant.attributes, price: moneyString(effectivePrice(variant)), available, stockPolicy: variant.stockPolicy, status: variant.status } : null, image: media ? { url: mediaPublicUrl(media.storageKey), alt: media.altText || translation?.name || '' } : null, available: Boolean(product?.status === 'published' && (!variant || (variant.status === 'active' && (variant.stockPolicy !== 'deny' || available > 0)))), createdAt: item.createdAt };
}

export async function getWishlist(id, locale = 'en') {
  const row = await Wishlist.findByPk(id, { include: [{ model: WishlistItem, as: 'items', include: itemInclude }] });
  if (!row) throw AppError.notFound('Wishlist not found.');
  return { id: row.id, items: row.items.map((item) => itemDto(item, locale)), itemCount: row.items.length };
}

export async function addWishlistItem(wishlistId, payload) {
  return sequelize.transaction(async (transaction) => {
    const wishlist = await Wishlist.findOne({ where: { id: wishlistId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!wishlist) throw AppError.notFound('Wishlist not found.');
    const product = await Product.findOne({ where: { id: payload.productId, status: 'published' }, transaction });
    if (!product) throw AppError.notFound('Product not found.');
    if (payload.variantId && !(await ProductVariant.findOne({ where: { id: payload.variantId, productId: product.id, status: 'active' }, transaction }))) throw AppError.unprocessable('INVALID_VARIANT', 'Choose an available variant for this product.');
    const itemKey = payload.variantId ? `variant:${payload.variantId}` : `product:${product.id}`;
    const [item, created] = await WishlistItem.findOrCreate({ where: { wishlistId, itemKey }, defaults: { id: newId(), wishlistId, productId: product.id, variantId: payload.variantId || null, itemKey }, transaction });
    if (!created) throw AppError.conflict('WISHLIST_ITEM_EXISTS', 'This item is already in your wishlist.');
    return item.id;
  });
}

export async function removeWishlistItem(wishlistId, itemId) {
  const count = await WishlistItem.destroy({ where: { id: itemId, wishlistId } });
  if (!count) throw AppError.notFound('Wishlist item not found.');
}

export async function mergeGuestWishlist(userWishlistId, guestToken) {
  if (!guestToken) return;
  await sequelize.transaction(async (transaction) => {
    const userWishlist = await Wishlist.findByPk(userWishlistId, { transaction, lock: transaction.LOCK.UPDATE });
    const guest = await Wishlist.findOne({ where: { tokenHash: sha256(guestToken), status: 'active', userId: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (!userWishlist || !guest || guest.id === userWishlist.id) return;
    const items = await WishlistItem.findAll({ where: { wishlistId: guest.id }, transaction });
    for (const item of items) await WishlistItem.findOrCreate({ where: { wishlistId: userWishlist.id, itemKey: item.itemKey }, defaults: { id: newId(), wishlistId: userWishlist.id, productId: item.productId, variantId: item.variantId, itemKey: item.itemKey }, transaction });
    guest.status = 'merged';
    await guest.save({ transaction });
  });
}
