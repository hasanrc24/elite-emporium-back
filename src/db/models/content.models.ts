import {
  DataTypes,
  DynamicModel,
  initializeModel,
  optimisticVersion,
  primaryId,
} from "./shared.js";

/** @type {any} */
export class Page extends DynamicModel {}
initializeModel(
  Page,
  {
    id: primaryId(),
    slug: { type: DataTypes.STRING(180), allowNull: false, unique: true },
    template: {
      type: DataTypes.STRING(80),
      allowNull: false,
      defaultValue: "standard",
    },
    status: {
      type: DataTypes.ENUM("draft", "scheduled", "published", "archived"),
      allowNull: false,
    },
    publishAt: DataTypes.DATE,
    version: optimisticVersion(),
    deletedAt: DataTypes.DATE,
  },
  { modelName: "Page", tableName: "pages", paranoid: true },
);
/** @type {any} */
export class PageTranslation extends DynamicModel {}
initializeModel(
  PageTranslation,
  {
    id: primaryId(),
    locale: { type: DataTypes.ENUM("en", "bn"), allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false },
    excerpt: DataTypes.TEXT,
    blocks: { type: DataTypes.JSON, allowNull: false },
    seoTitle: DataTypes.STRING(255),
    seoDescription: DataTypes.STRING(500),
  },
  {
    modelName: "PageTranslation",
    tableName: "page_translations",
    indexes: [{ unique: true, fields: ["pageId", "locale"] }],
  },
);
/** @type {any} */
export class PostCategory extends DynamicModel {}
initializeModel(
  PostCategory,
  {
    id: primaryId(),
    slug: { type: DataTypes.STRING(160), allowNull: false, unique: true },
    nameEn: { type: DataTypes.STRING(180), allowNull: false },
    nameBn: { type: DataTypes.STRING(180), allowNull: false },
    deletedAt: DataTypes.DATE,
  },
  { modelName: "PostCategory", tableName: "post_categories", paranoid: true },
);
/** @type {any} */
export class Post extends DynamicModel {}
initializeModel(
  Post,
  {
    id: primaryId(),
    slug: { type: DataTypes.STRING(180), allowNull: false, unique: true },
    type: {
      type: DataTypes.ENUM("blog", "lookbook"),
      allowNull: false,
      defaultValue: "blog",
    },
    status: {
      type: DataTypes.ENUM("draft", "scheduled", "published", "archived"),
      allowNull: false,
    },
    publishAt: DataTypes.DATE,
    version: optimisticVersion(),
    deletedAt: DataTypes.DATE,
  },
  { modelName: "Post", tableName: "posts", paranoid: true },
);
/** @type {any} */
export class PostTranslation extends DynamicModel {}
initializeModel(
  PostTranslation,
  {
    id: primaryId(),
    locale: { type: DataTypes.ENUM("en", "bn"), allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false },
    excerpt: DataTypes.TEXT,
    blocks: { type: DataTypes.JSON, allowNull: false },
    seoTitle: DataTypes.STRING(255),
    seoDescription: DataTypes.STRING(500),
  },
  {
    modelName: "PostTranslation",
    tableName: "post_translations",
    indexes: [{ unique: true, fields: ["postId", "locale"] }],
  },
);
/** @type {any} */
export class Menu extends DynamicModel {}
initializeModel(
  Menu,
  {
    id: primaryId(),
    location: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    status: {
      type: DataTypes.ENUM("draft", "published"),
      allowNull: false,
      defaultValue: "draft",
    },
    version: optimisticVersion(),
  },
  { modelName: "Menu", tableName: "menus" },
);
/** @type {any} */
export class MenuItem extends DynamicModel {}
initializeModel(
  MenuItem,
  {
    id: primaryId(),
    targetType: {
      type: DataTypes.ENUM("url", "product", "category", "collection", "page"),
      allowNull: false,
    },
    targetId: DataTypes.CHAR(26),
    url: DataTypes.STRING(1000),
    labelEn: { type: DataTypes.STRING(180), allowNull: false },
    labelBn: { type: DataTypes.STRING(180), allowNull: false },
    displayOrder: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    visible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { modelName: "MenuItem", tableName: "menu_items" },
);
/** @type {any} */
export class HomepageSection extends DynamicModel {}
initializeModel(
  HomepageSection,
  {
    id: primaryId(),
    type: {
      type: DataTypes.ENUM(
        "hero",
        "banner",
        "product_carousel",
        "category_grid",
        "collection_grid",
        "countdown",
        "testimonials",
        "editorial",
        "newsletter",
        "blog_feed",
      ),
      allowNull: false,
    },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    displayOrder: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    startsAt: DataTypes.DATE,
    endsAt: DataTypes.DATE,
    config: { type: DataTypes.JSON, allowNull: false },
    status: {
      type: DataTypes.ENUM("draft", "published"),
      allowNull: false,
      defaultValue: "draft",
    },
    version: optimisticVersion(),
    deletedAt: DataTypes.DATE,
  },
  {
    modelName: "HomepageSection",
    tableName: "homepage_sections",
    paranoid: true,
  },
);
/** @type {any} */
export class ThemeSetting extends DynamicModel {}
initializeModel(
  ThemeSetting,
  {
    id: primaryId(),
    status: { type: DataTypes.ENUM("draft", "published"), allowNull: false },
    settings: { type: DataTypes.JSON, allowNull: false },
    version: optimisticVersion(),
    publishedAt: DataTypes.DATE,
  },
  { modelName: "ThemeSetting", tableName: "theme_settings" },
);
/** @type {any} */
export class ContentRevision extends DynamicModel {}
initializeModel(
  ContentRevision,
  {
    id: primaryId(),
    entityType: { type: DataTypes.STRING(80), allowNull: false },
    entityId: { type: DataTypes.CHAR(26), allowNull: false },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    changeSummary: DataTypes.STRING(500),
    publishedAt: DataTypes.DATE,
  },
  {
    modelName: "ContentRevision",
    tableName: "content_revisions",
    updatedAt: false,
  },
);
