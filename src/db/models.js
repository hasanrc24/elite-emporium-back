import * as identity from './models/identity.models.js';
import * as catalog from './models/catalog.models.js';
import * as commerce from './models/commerce.models.js';
import * as content from './models/content.models.js';
import * as platform from './models/platform.models.js';

export const {
  User, Role, Permission, UserPermissionOverride, AuthSession, VerificationToken,
  PasswordResetToken, AuthChallenge, MfaMethod, MfaRecoveryCode, UserAddress,
  CustomerNote, PrivacyRequest,
} = /** @type {any} */ (identity);
export const {
  MediaAsset, Category, CategoryTranslation, Collection, CollectionTranslation,
  Brand, BrandTranslation, Attribute, AttributeTranslation, AttributeValue,
  AttributeValueTranslation, Product, ProductTranslation, ProductVariant,
  ProductMedia, ProductAttribute, ProductTag, SizeChart, SizeChartRow,
  RelatedProduct, Redirect, StockLocation, InventoryLevel, InventoryReservation,
  InventoryMovement,
} = /** @type {any} */ (catalog);
export const {
  StoreSetting, FeatureFlag, Cart, CartItem, Coupon, CartCoupon, CouponUsage,
  CouponProduct, CouponProductExclusion, CouponCategory, CouponCategoryExclusion,
  CouponUser, CouponPhone,
  Order, OrderItem, OrderAddress, OrderEvent, OrderNote, IdempotencyRecord, CheckoutQuote,
  Payment, PaymentAttempt, Refund, ShippingZone, ShippingMethod, Shipment,
  ShipmentEvent, Wishlist, WishlistItem, Review, ReturnRequest, ReturnItem,
  ReturnEvent,
  ReturnMedia,
} = /** @type {any} */ (commerce);
export const {
  Page, PageTranslation, PostCategory, Post, PostTranslation, Menu, MenuItem,
  HomepageSection, ThemeSetting, ContentRevision,
} = /** @type {any} */ (content);
export const {
  AuditLog, NotificationTemplate, NotificationOutbox, OutboxEvent,
  IntegrationCredential, Webhook, WebhookDelivery, ContactMessage, ExportJob,
} = /** @type {any} */ (platform);

User.belongsToMany(Role, { through: 'user_roles', as: 'roles', foreignKey: 'userId' });
Role.belongsToMany(User, { through: 'user_roles', as: 'users', foreignKey: 'roleId' });
Role.belongsToMany(Permission, { through: 'role_permissions', as: 'permissions', foreignKey: 'roleId' });
Permission.belongsToMany(Role, { through: 'role_permissions', as: 'roles', foreignKey: 'permissionId' });
User.hasMany(UserPermissionOverride, { as: 'permissionOverrides', foreignKey: 'userId' });
UserPermissionOverride.belongsTo(User, { as: 'user', foreignKey: 'userId' });
UserPermissionOverride.belongsTo(User, { as: 'actor', foreignKey: 'actorId' });
UserPermissionOverride.belongsTo(Permission, { as: 'permission', foreignKey: 'permissionId' });
User.hasMany(AuthSession, { as: 'sessions', foreignKey: 'userId' });
AuthSession.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(VerificationToken, { as: 'verificationTokens', foreignKey: 'userId' });
VerificationToken.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(PasswordResetToken, { as: 'passwordResetTokens', foreignKey: 'userId' });
PasswordResetToken.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(AuthChallenge, { as: 'authChallenges', foreignKey: 'userId' });
AuthChallenge.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(MfaMethod, { as: 'mfaMethods', foreignKey: 'userId' });
MfaMethod.belongsTo(User, { as: 'user', foreignKey: 'userId' });
MfaMethod.hasMany(MfaRecoveryCode, { as: 'recoveryCodes', foreignKey: 'methodId' });
MfaRecoveryCode.belongsTo(MfaMethod, { as: 'method', foreignKey: 'methodId' });
User.hasMany(UserAddress, { as: 'addresses', foreignKey: 'userId' });
UserAddress.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(CustomerNote, { as: 'customerNotes', foreignKey: 'userId' });
CustomerNote.belongsTo(User, { as: 'user', foreignKey: 'userId' });
CustomerNote.belongsTo(User, { as: 'actor', foreignKey: 'actorId' });
User.hasMany(PrivacyRequest, { as: 'privacyRequests', foreignKey: 'userId' });
PrivacyRequest.belongsTo(User, { as: 'user', foreignKey: 'userId' });
PrivacyRequest.belongsTo(User, { as: 'reviewer', foreignKey: 'reviewedBy' });
PrivacyRequest.hasOne(ExportJob, { as: 'exportJob', foreignKey: 'privacyRequestId' });
ExportJob.belongsTo(PrivacyRequest, { as: 'privacyRequest', foreignKey: 'privacyRequestId' });
User.hasMany(MediaAsset, { as: 'uploadedMedia', foreignKey: 'uploaderId' });
MediaAsset.belongsTo(User, { as: 'uploader', foreignKey: 'uploaderId' });
User.hasMany(AuditLog, { as: 'auditLogs', foreignKey: 'actorId' });
AuditLog.belongsTo(User, { as: 'actor', foreignKey: 'actorId' });

Category.belongsTo(Category, { as: 'parent', foreignKey: 'parentId' });
Category.hasMany(Category, { as: 'children', foreignKey: 'parentId' });
Category.hasMany(CategoryTranslation, { as: 'translations', foreignKey: 'categoryId' });
CategoryTranslation.belongsTo(Category, { as: 'category', foreignKey: 'categoryId' });
Category.belongsTo(MediaAsset, { as: 'image', foreignKey: 'imageId' });
Collection.hasMany(CollectionTranslation, { as: 'translations', foreignKey: 'collectionId' });
CollectionTranslation.belongsTo(Collection, { as: 'collection', foreignKey: 'collectionId' });
Collection.belongsTo(MediaAsset, { as: 'image', foreignKey: 'imageId' });
Brand.hasMany(BrandTranslation, { as: 'translations', foreignKey: 'brandId' });
BrandTranslation.belongsTo(Brand, { as: 'brand', foreignKey: 'brandId' });
Brand.belongsTo(MediaAsset, { as: 'logo', foreignKey: 'logoId' });
Attribute.hasMany(AttributeTranslation, { as: 'translations', foreignKey: 'attributeId' });
AttributeTranslation.belongsTo(Attribute, { as: 'attribute', foreignKey: 'attributeId' });
Attribute.hasMany(AttributeValue, { as: 'values', foreignKey: 'attributeId' });
AttributeValue.belongsTo(Attribute, { as: 'attribute', foreignKey: 'attributeId' });
AttributeValue.hasMany(AttributeValueTranslation, { as: 'translations', foreignKey: 'valueId' });
AttributeValueTranslation.belongsTo(AttributeValue, { as: 'value', foreignKey: 'valueId' });
AttributeValue.belongsTo(MediaAsset, { as: 'swatchMedia', foreignKey: 'swatchMediaId' });

Category.hasMany(Product, { as: 'primaryProducts', foreignKey: 'categoryId' });
Product.belongsTo(Category, { as: 'category', foreignKey: 'categoryId' });
Brand.hasMany(Product, { as: 'products', foreignKey: 'brandId' });
Product.belongsTo(Brand, { as: 'brand', foreignKey: 'brandId' });
Product.belongsToMany(Category, { through: 'product_categories', as: 'categories', foreignKey: 'productId', otherKey: 'categoryId' });
Category.belongsToMany(Product, { through: 'product_categories', as: 'products', foreignKey: 'categoryId', otherKey: 'productId' });
Product.belongsToMany(Collection, { through: 'product_collections', as: 'collections', foreignKey: 'productId', otherKey: 'collectionId' });
Collection.belongsToMany(Product, { through: 'product_collections', as: 'products', foreignKey: 'collectionId', otherKey: 'productId' });
Product.hasMany(ProductTranslation, { as: 'translations', foreignKey: 'productId' });
ProductTranslation.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
Product.hasMany(ProductVariant, { as: 'variants', foreignKey: 'productId' });
ProductVariant.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
Product.hasMany(ProductMedia, { as: 'media', foreignKey: 'productId' });
ProductVariant.hasMany(ProductMedia, { as: 'media', foreignKey: 'variantId' });
ProductMedia.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
ProductMedia.belongsTo(ProductVariant, { as: 'variant', foreignKey: 'variantId' });
ProductMedia.belongsTo(MediaAsset, { as: 'asset', foreignKey: 'mediaId' });
Product.hasMany(ProductTag, { as: 'tags', foreignKey: 'productId' });
ProductTag.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
Product.belongsToMany(Attribute, { through: ProductAttribute, as: 'attributesDefinition', foreignKey: 'productId', otherKey: 'attributeId' });
Attribute.belongsToMany(Product, { through: ProductAttribute, as: 'products', foreignKey: 'attributeId', otherKey: 'productId' });
ProductVariant.belongsToMany(AttributeValue, { through: 'variant_attribute_values', as: 'attributeValues', foreignKey: 'variantId', otherKey: 'valueId' });
AttributeValue.belongsToMany(ProductVariant, { through: 'variant_attribute_values', as: 'variants', foreignKey: 'valueId', otherKey: 'variantId' });
Product.belongsToMany(SizeChart, { through: 'product_size_charts', as: 'sizeCharts', foreignKey: 'productId', otherKey: 'chartId' });
SizeChart.belongsToMany(Product, { through: 'product_size_charts', as: 'products', foreignKey: 'chartId', otherKey: 'productId' });
SizeChart.hasMany(SizeChartRow, { as: 'rows', foreignKey: 'chartId' });
SizeChartRow.belongsTo(SizeChart, { as: 'chart', foreignKey: 'chartId' });
Product.belongsToMany(Product, { through: RelatedProduct, as: 'relatedTargets', foreignKey: 'sourceProductId', otherKey: 'targetProductId' });

ProductVariant.hasOne(InventoryLevel, { as: 'inventory', foreignKey: 'variantId' });
ProductVariant.hasMany(InventoryLevel, { as: 'inventoryLevels', foreignKey: 'variantId' });
InventoryLevel.belongsTo(ProductVariant, { as: 'variant', foreignKey: 'variantId' });
StockLocation.hasMany(InventoryLevel, { as: 'levels', foreignKey: 'locationId' });
InventoryLevel.belongsTo(StockLocation, { as: 'location', foreignKey: 'locationId' });
ProductVariant.hasMany(InventoryReservation, { as: 'reservations', foreignKey: 'variantId' });
InventoryReservation.belongsTo(ProductVariant, { as: 'variant', foreignKey: 'variantId' });
InventoryReservation.belongsTo(StockLocation, { as: 'location', foreignKey: 'locationId' });
ProductVariant.hasMany(InventoryMovement, { as: 'movements', foreignKey: 'variantId' });
InventoryMovement.belongsTo(ProductVariant, { as: 'variant', foreignKey: 'variantId' });
InventoryMovement.belongsTo(StockLocation, { as: 'location', foreignKey: 'locationId' });
InventoryMovement.belongsTo(User, { as: 'actor', foreignKey: 'actorId' });

User.hasMany(Cart, { as: 'carts', foreignKey: 'userId' });
Cart.belongsTo(User, { as: 'user', foreignKey: 'userId' });
Cart.hasMany(CartItem, { as: 'items', foreignKey: 'cartId' });
CartItem.belongsTo(Cart, { as: 'cart', foreignKey: 'cartId' });
CartItem.belongsTo(ProductVariant, { as: 'variant', foreignKey: 'variantId' });
Cart.belongsToMany(Coupon, { through: CartCoupon, as: 'coupons', foreignKey: 'cartId', otherKey: 'couponId' });
Coupon.belongsToMany(Cart, { through: CartCoupon, as: 'carts', foreignKey: 'couponId', otherKey: 'cartId' });
Cart.hasMany(CheckoutQuote, { as: 'checkoutQuotes', foreignKey: 'cartId' });
CheckoutQuote.belongsTo(Cart, { as: 'cart', foreignKey: 'cartId' });
User.hasMany(CheckoutQuote, { as: 'checkoutQuotes', foreignKey: 'userId' });
CheckoutQuote.belongsTo(User, { as: 'user', foreignKey: 'userId' });
Coupon.belongsToMany(Product, { through: CouponProduct, as: 'includedProducts', foreignKey: 'couponId', otherKey: 'productId' });
Coupon.belongsToMany(Product, { through: CouponProductExclusion, as: 'excludedProducts', foreignKey: 'couponId', otherKey: 'productId' });
Coupon.belongsToMany(Category, { through: CouponCategory, as: 'includedCategories', foreignKey: 'couponId', otherKey: 'categoryId' });
Coupon.belongsToMany(Category, { through: CouponCategoryExclusion, as: 'excludedCategories', foreignKey: 'couponId', otherKey: 'categoryId' });
Coupon.belongsToMany(User, { through: CouponUser, as: 'eligibleUsers', foreignKey: 'couponId', otherKey: 'userId' });
User.belongsToMany(Coupon, { through: CouponUser, as: 'eligibleCoupons', foreignKey: 'userId', otherKey: 'couponId' });
Coupon.hasMany(CouponPhone, { as: 'eligiblePhones', foreignKey: 'couponId' });
CouponPhone.belongsTo(Coupon, { as: 'coupon', foreignKey: 'couponId' });

User.hasMany(Order, { as: 'orders', foreignKey: 'userId' });
Order.belongsTo(User, { as: 'user', foreignKey: 'userId' });
Order.hasMany(OrderItem, { as: 'items', foreignKey: 'orderId' });
OrderItem.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
OrderItem.belongsTo(ProductVariant, { as: 'variant', foreignKey: 'variantId' });
Order.hasMany(OrderAddress, { as: 'addresses', foreignKey: 'orderId' });
OrderAddress.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
Order.hasMany(OrderEvent, { as: 'events', foreignKey: 'orderId' });
OrderEvent.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
OrderEvent.belongsTo(User, { as: 'actor', foreignKey: 'actorId' });
Order.hasMany(OrderNote, { as: 'notes', foreignKey: 'orderId' });
OrderNote.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
OrderNote.belongsTo(User, { as: 'actor', foreignKey: 'actorId' });
InventoryMovement.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
Coupon.hasMany(CouponUsage, { as: 'usages', foreignKey: 'couponId' });
CouponUsage.belongsTo(Coupon, { as: 'coupon', foreignKey: 'couponId' });
CouponUsage.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
CouponUsage.belongsTo(User, { as: 'user', foreignKey: 'userId' });
Order.hasMany(Payment, { as: 'payments', foreignKey: 'orderId' });
Payment.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
Payment.hasMany(PaymentAttempt, { as: 'attempts', foreignKey: 'paymentId' });
PaymentAttempt.belongsTo(Payment, { as: 'payment', foreignKey: 'paymentId' });
Payment.hasMany(Refund, { as: 'refunds', foreignKey: 'paymentId' });
Refund.belongsTo(Payment, { as: 'payment', foreignKey: 'paymentId' });
Refund.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
Refund.belongsTo(User, { as: 'actor', foreignKey: 'actorId' });

ShippingZone.hasMany(ShippingMethod, { as: 'methods', foreignKey: 'zoneId' });
ShippingMethod.belongsTo(ShippingZone, { as: 'zone', foreignKey: 'zoneId' });
Order.hasMany(Shipment, { as: 'shipments', foreignKey: 'orderId' });
Shipment.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
Shipment.belongsTo(MediaAsset, { as: 'labelMedia', foreignKey: 'labelMediaId' });
Shipment.hasMany(ShipmentEvent, { as: 'events', foreignKey: 'shipmentId' });
ShipmentEvent.belongsTo(Shipment, { as: 'shipment', foreignKey: 'shipmentId' });

User.hasMany(Wishlist, { as: 'wishlists', foreignKey: 'userId' });
Wishlist.belongsTo(User, { as: 'user', foreignKey: 'userId' });
Wishlist.hasMany(WishlistItem, { as: 'items', foreignKey: 'wishlistId' });
WishlistItem.belongsTo(Wishlist, { as: 'wishlist', foreignKey: 'wishlistId' });
WishlistItem.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
WishlistItem.belongsTo(ProductVariant, { as: 'variant', foreignKey: 'variantId' });
Product.hasMany(Review, { as: 'reviews', foreignKey: 'productId' });
Review.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
User.hasMany(Review, { as: 'reviews', foreignKey: 'userId' });
Review.belongsTo(User, { as: 'user', foreignKey: 'userId' });
Review.belongsTo(OrderItem, { as: 'orderItem', foreignKey: 'orderItemId' });
Review.belongsTo(User, { as: 'moderator', foreignKey: 'moderatedBy' });
Review.belongsToMany(MediaAsset, { through: 'review_media', as: 'media', foreignKey: 'reviewId', otherKey: 'mediaId' });
Order.hasMany(ReturnRequest, { as: 'returns', foreignKey: 'orderId' });
ReturnRequest.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
ReturnRequest.belongsTo(User, { as: 'user', foreignKey: 'userId' });
ReturnRequest.belongsTo(Order, { as: 'replacementOrder', foreignKey: 'replacementOrderId' });
ReturnRequest.hasMany(ReturnItem, { as: 'items', foreignKey: 'returnId' });
ReturnItem.belongsTo(ReturnRequest, { as: 'return', foreignKey: 'returnId' });
ReturnItem.belongsTo(OrderItem, { as: 'orderItem', foreignKey: 'orderItemId' });
ReturnRequest.hasMany(ReturnEvent, { as: 'events', foreignKey: 'returnId' });
ReturnEvent.belongsTo(ReturnRequest, { as: 'return', foreignKey: 'returnId' });
ReturnEvent.belongsTo(User, { as: 'actor', foreignKey: 'actorId' });
ReturnRequest.belongsToMany(MediaAsset, { through: ReturnMedia, as: 'media', foreignKey: 'returnId', otherKey: 'mediaId' });
MediaAsset.belongsToMany(ReturnRequest, { through: ReturnMedia, as: 'returns', foreignKey: 'mediaId', otherKey: 'returnId' });
ReturnRequest.hasOne(Refund, { as: 'refund', foreignKey: 'returnId' });
Refund.belongsTo(ReturnRequest, { as: 'return', foreignKey: 'returnId' });
ReturnItem.belongsTo(StockLocation, { as: 'restockLocation', foreignKey: 'restockLocationId' });
InventoryMovement.belongsTo(ReturnRequest, { as: 'return', foreignKey: 'returnId' });

Page.hasMany(PageTranslation, { as: 'translations', foreignKey: 'pageId' });
PageTranslation.belongsTo(Page, { as: 'page', foreignKey: 'pageId' });
PostCategory.hasMany(Post, { as: 'posts', foreignKey: 'categoryId' });
Post.belongsTo(PostCategory, { as: 'category', foreignKey: 'categoryId' });
User.hasMany(Post, { as: 'posts', foreignKey: 'authorId' });
Post.belongsTo(User, { as: 'author', foreignKey: 'authorId' });
Post.belongsTo(MediaAsset, { as: 'coverMedia', foreignKey: 'coverMediaId' });
Post.hasMany(PostTranslation, { as: 'translations', foreignKey: 'postId' });
PostTranslation.belongsTo(Post, { as: 'post', foreignKey: 'postId' });
Menu.hasMany(MenuItem, { as: 'items', foreignKey: 'menuId' });
MenuItem.belongsTo(Menu, { as: 'menu', foreignKey: 'menuId' });
MenuItem.belongsTo(MenuItem, { as: 'parent', foreignKey: 'parentId' });
MenuItem.hasMany(MenuItem, { as: 'children', foreignKey: 'parentId' });
ContentRevision.belongsTo(User, { as: 'actor', foreignKey: 'actorId' });

NotificationOutbox.belongsTo(NotificationTemplate, { as: 'template', foreignKey: 'templateId' });
IntegrationCredential.belongsTo(User, { as: 'updatedByUser', foreignKey: 'updatedBy' });
Webhook.hasMany(WebhookDelivery, { as: 'deliveries', foreignKey: 'webhookId' });
WebhookDelivery.belongsTo(Webhook, { as: 'webhook', foreignKey: 'webhookId' });
WebhookDelivery.belongsTo(OutboxEvent, { as: 'event', foreignKey: 'eventId' });
ExportJob.belongsTo(User, { as: 'requester', foreignKey: 'requestedBy' });
ExportJob.belongsTo(MediaAsset, { as: 'file', foreignKey: 'mediaId' });

export const models = { ...identity, ...catalog, ...commerce, ...content, ...platform };
