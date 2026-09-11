import { Injectable } from "@nestjs/common";
import * as customers from "../modules/admin/customer.service.js";
import * as operations from "../modules/admin/operations.service.js";
import * as roles from "../modules/admin/role.service.js";
import * as staff from "../modules/admin/staff.service.js";
import * as auth from "../modules/auth/auth.service.js";
import * as carts from "../modules/cart/cart.service.js";
import * as adminProducts from "../modules/catalog/admin-product.service.js";
import * as catalog from "../modules/catalog/catalog.service.js";
import * as taxonomies from "../modules/catalog/taxonomy.service.js";
import * as variantMatrix from "../modules/catalog/variant-matrix.service.js";
import * as content from "../modules/content/content.service.js";
import * as integrations from "../modules/integrations/integration.service.js";
import * as inventory from "../modules/inventory/inventory.service.js";
import * as media from "../modules/media/media.service.js";
import * as adminOrders from "../modules/orders/admin-order.service.js";
import * as orders from "../modules/orders/order.service.js";
import * as payments from "../modules/payments/payment.service.js";
import * as refunds from "../modules/payments/refund.service.js";
import * as coupons from "../modules/promotions/admin-coupon.service.js";
import * as adminReturns from "../modules/returns/admin-return.service.js";
import * as returns from "../modules/returns/return.service.js";
import * as reviews from "../modules/reviews/review.service.js";
import * as shipping from "../modules/shipping/admin-shipping.service.js";
import * as privacy from "../modules/users/privacy.service.js";
import * as users from "../modules/users/user.service.js";
import * as wishlists from "../modules/wishlist/wishlist.service.js";

@Injectable()
export class ApplicationServices {
  readonly adminOrders = {
    addOrderNote: adminOrders.addOrderNote,
    cancelAdminOrder: adminOrders.cancelAdminOrder,
    collectCod: adminOrders.collectCod,
    createManualOrder: adminOrders.createManualOrder,
    getAdminOrder: adminOrders.getAdminOrder,
    getPayment: adminOrders.getPayment,
    listAdminOrders: adminOrders.listAdminOrders,
    listPayments: adminOrders.listPayments,
    transitionOrder: adminOrders.transitionOrder,
  };
  readonly adminProducts = {
    archiveProduct: adminProducts.archiveProduct,
    bulkUpdateProducts: adminProducts.bulkUpdateProducts,
    changePublication: adminProducts.changePublication,
    duplicateProduct: adminProducts.duplicateProduct,
    getAdminProduct: adminProducts.getAdminProduct,
    listAdminProducts: adminProducts.listAdminProducts,
    restoreProduct: adminProducts.restoreProduct,
    updateProduct: adminProducts.updateProduct,
  };
  readonly adminReturns = {
    addReturnEvent: adminReturns.addReturnEvent,
    approveReturn: adminReturns.approveReturn,
    completeReturn: adminReturns.completeReturn,
    createExchangeDraft: adminReturns.createExchangeDraft,
    getAdminReturn: adminReturns.getAdminReturn,
    inspectReturn: adminReturns.inspectReturn,
    listAdminReturns: adminReturns.listAdminReturns,
    markReturnInTransit: adminReturns.markReturnInTransit,
    receiveReturn: adminReturns.receiveReturn,
    rejectReturn: adminReturns.rejectReturn,
    startReview: adminReturns.startReview,
  };
  readonly auth = {
    changePassword: auth.changePassword,
    confirmMfa: auth.confirmMfa,
    disableMfa: auth.disableMfa,
    forgotPassword: auth.forgotPassword,
    listSessions: auth.listSessions,
    login: auth.login,
    logout: auth.logout,
    logoutAll: auth.logoutAll,
    publicUser: auth.publicUser,
    refresh: auth.refresh,
    register: auth.register,
    resendVerification: auth.resendVerification,
    resetPassword: auth.resetPassword,
    revokeSession: auth.revokeSession,
    setupMfa: auth.setupMfa,
    verifyIdentity: auth.verifyIdentity,
    verifyMfaLogin: auth.verifyMfaLogin,
  };
  readonly carts = {
    CART_COOKIE: carts.CART_COOKIE,
    addItem: carts.addItem,
    applyCoupon: carts.applyCoupon,
    getCart: carts.getCart,
    mergeGuestCart: carts.mergeGuestCart,
    removeCoupon: carts.removeCoupon,
    removeItem: carts.removeItem,
    resolveCart: carts.resolveCart,
    updateItem: carts.updateItem,
  };
  readonly catalog = {
    createProduct: catalog.createProduct,
    getCategory: catalog.getCategory,
    getCollection: catalog.getCollection,
    getProduct: catalog.getProduct,
    listAttributes: catalog.listAttributes,
    listBrands: catalog.listBrands,
    listCategories: catalog.listCategories,
    listCollections: catalog.listCollections,
    listProducts: catalog.listProducts,
    publicProduct: catalog.publicProduct,
    searchSuggestions: catalog.searchSuggestions,
  };
  readonly content = {
    getAdminContent: content.getAdminContent,
    getPublicPage: content.getPublicPage,
    getPublicPost: content.getPublicPost,
    getThemeAdmin: content.getThemeAdmin,
    listAdminContent: content.listAdminContent,
    listHomeAdmin: content.listHomeAdmin,
    listMenusAdmin: content.listMenusAdmin,
    listPublicPosts: content.listPublicPosts,
    listRevisions: content.listRevisions,
    rollbackContent: content.rollbackContent,
    saveContent: content.saveContent,
    saveHomeSection: content.saveHomeSection,
    saveMenu: content.saveMenu,
    saveTheme: content.saveTheme,
    sitemapData: content.sitemapData,
    storefrontHome: content.storefrontHome,
    storefrontNavigation: content.storefrontNavigation,
    submitContact: content.submitContact,
  };
  readonly coupons = {
    archiveCoupon: coupons.archiveCoupon,
    createCoupon: coupons.createCoupon,
    duplicateCoupon: coupons.duplicateCoupon,
    getCoupon: coupons.getCoupon,
    listCouponUsage: coupons.listCouponUsage,
    listCoupons: coupons.listCoupons,
    restoreCoupon: coupons.restoreCoupon,
    setCouponActive: coupons.setCouponActive,
    updateCoupon: coupons.updateCoupon,
  };
  readonly customers = {
    addCustomerNote: customers.addCustomerNote,
    getCustomer: customers.getCustomer,
    listCustomers: customers.listCustomers,
    updateCustomer: customers.updateCustomer,
  };
  readonly integrations = {
    configureBkash: integrations.configureBkash,
    configureMessaging: integrations.configureMessaging,
    listIntegrations: integrations.listIntegrations,
    setBkashEnabled: integrations.setBkashEnabled,
    setMessagingEnabled: integrations.setMessagingEnabled,
    testBkash: integrations.testBkash,
    testMessaging: integrations.testMessaging,
  };
  readonly inventory = {
    adjustInventory: inventory.adjustInventory,
    createLocation: inventory.createLocation,
    listLevels: inventory.listLevels,
    listLocations: inventory.listLocations,
    listMovements: inventory.listMovements,
    updateLocation: inventory.updateLocation,
  };
  readonly media = {
    archiveMedia: media.archiveMedia,
    mediaDto: media.mediaDto,
    mediaUsage: media.mediaUsage,
    updateMedia: media.updateMedia,
    uploadMedia: media.uploadMedia,
  };
  readonly operations = {
    archiveWebhook: operations.archiveWebhook,
    cancelExport: operations.cancelExport,
    createExport: operations.createExport,
    getExport: operations.getExport,
    getNotificationDelivery: operations.getNotificationDelivery,
    getNotificationTemplate: operations.getNotificationTemplate,
    listAudits: operations.listAudits,
    listContactMessages: operations.listContactMessages,
    listExports: operations.listExports,
    listNotificationOutbox: operations.listNotificationOutbox,
    listNotificationTemplates: operations.listNotificationTemplates,
    listWebhookDeliveries: operations.listWebhookDeliveries,
    listWebhooks: operations.listWebhooks,
    previewNotificationTemplate: operations.previewNotificationTemplate,
    reportData: operations.reportData,
    reportSummary: operations.reportSummary,
    retryNotification: operations.retryNotification,
    retryWebhookDelivery: operations.retryWebhookDelivery,
    rotateWebhookSecret: operations.rotateWebhookSecret,
    saveWebhook: operations.saveWebhook,
    testNotificationTemplate: operations.testNotificationTemplate,
    testWebhook: operations.testWebhook,
    updateContactMessage: operations.updateContactMessage,
    updateNotificationTemplate: operations.updateNotificationTemplate,
  };
  readonly orders = {
    cancelOrder: orders.cancelOrder,
    createOrder: orders.createOrder,
    getOrder: orders.getOrder,
    listOrders: orders.listOrders,
    quote: orders.quote,
    trackOrder: orders.trackOrder,
  };
  readonly payments = {
    processBkashCallback: payments.processBkashCallback,
    recoverBkashPayment: payments.recoverBkashPayment,
    startBkashPayment: payments.startBkashPayment,
  };
  readonly privacy = {
    createPrivacyRequest: privacy.createPrivacyRequest,
    getAdminPrivacyRequest: privacy.getAdminPrivacyRequest,
    listAdminPrivacyRequests: privacy.listAdminPrivacyRequests,
    listOwnPrivacyRequests: privacy.listOwnPrivacyRequests,
    transitionPrivacyRequest: privacy.transitionPrivacyRequest,
  };
  readonly refunds = {
    cancelRefund: refunds.cancelRefund,
    completeManualRefund: refunds.completeManualRefund,
    createRefund: refunds.createRefund,
    getPaymentRefundCapacity: refunds.getPaymentRefundCapacity,
    getRefund: refunds.getRefund,
    listRefunds: refunds.listRefunds,
    reconcileBkashRefund: refunds.reconcileBkashRefund,
  };
  readonly returns = {
    cancelReturn: returns.cancelReturn,
    createReturn: returns.createReturn,
    getReturn: returns.getReturn,
    getReturnEligibility: returns.getReturnEligibility,
    guestLookup: returns.guestLookup,
    listReturns: returns.listReturns,
    verifyGuestReturnUpload: returns.verifyGuestReturnUpload,
  };
  readonly reviews = {
    createReview: reviews.createReview,
    deleteReview: reviews.deleteReview,
    listAdminReviews: reviews.listAdminReviews,
    listOwnReviews: reviews.listOwnReviews,
    listPublicReviews: reviews.listPublicReviews,
    moderateReview: reviews.moderateReview,
    respondToReview: reviews.respondToReview,
    updateReview: reviews.updateReview,
  };
  readonly roles = {
    archiveRole: roles.archiveRole,
    createRole: roles.createRole,
    listPermissions: roles.listPermissions,
    listRoles: roles.listRoles,
    ownerInvariantSummary: roles.ownerInvariantSummary,
    updateRole: roles.updateRole,
  };
  readonly shipping = {
    archiveShippingResource: shipping.archiveShippingResource,
    createShipment: shipping.createShipment,
    listShipments: shipping.listShipments,
    listShippingConfiguration: shipping.listShippingConfiguration,
    restoreShippingResource: shipping.restoreShippingResource,
    saveMethod: shipping.saveMethod,
    saveZone: shipping.saveZone,
    updateShipment: shipping.updateShipment,
  };
  readonly staff = {
    createStaff: staff.createStaff,
    getStaff: staff.getStaff,
    listStaff: staff.listStaff,
    listStaffSessions: staff.listStaffSessions,
    resetStaffPassword: staff.resetStaffPassword,
    revokeStaffSession: staff.revokeStaffSession,
    updateStaffAccess: staff.updateStaffAccess,
    updateStaffProfile: staff.updateStaffProfile,
  };
  readonly taxonomies = {
    archiveTaxonomy: taxonomies.archiveTaxonomy,
    attributeUsage: taxonomies.attributeUsage,
    createAttribute: taxonomies.createAttribute,
    createTaxonomy: taxonomies.createTaxonomy,
    getTaxonomy: taxonomies.getTaxonomy,
    listAdminAttributes: taxonomies.listAdminAttributes,
    listTaxonomies: taxonomies.listTaxonomies,
    reorderTaxonomies: taxonomies.reorderTaxonomies,
    restoreTaxonomy: taxonomies.restoreTaxonomy,
    updateTaxonomy: taxonomies.updateTaxonomy,
  };
  readonly users = {
    createAddress: users.createAddress,
    deleteAddress: users.deleteAddress,
    listAddresses: users.listAddresses,
    updateAddress: users.updateAddress,
    updateProfile: users.updateProfile,
  };
  readonly variantMatrix = {
    archiveVariant: variantMatrix.archiveVariant,
    commitVariantMatrix: variantMatrix.commitVariantMatrix,
    previewVariantMatrix: variantMatrix.previewVariantMatrix,
    restoreVariant: variantMatrix.restoreVariant,
    updateVariant: variantMatrix.updateVariant,
  };
  readonly wishlists = {
    WISHLIST_COOKIE: wishlists.WISHLIST_COOKIE,
    addWishlistItem: wishlists.addWishlistItem,
    getWishlist: wishlists.getWishlist,
    mergeGuestWishlist: wishlists.mergeGuestWishlist,
    removeWishlistItem: wishlists.removeWishlistItem,
    resolveWishlist: wishlists.resolveWishlist,
  };
}
