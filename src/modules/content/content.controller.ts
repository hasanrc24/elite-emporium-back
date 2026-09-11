import {
  Controller,
  Get,
  Inject,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import type { Request, Response } from "express";
import { ApplicationServices } from "../../app/application-services.js";
import {
  AccessTokenGuard,
  ContactRateLimitGuard,
  PermissionGuard,
  Permissions,
  ValidateRequest,
} from "../../app/request-security.js";
const locale = (req: Request): "en" | "bn" =>
  req.query.locale === "bn" ? "bn" : "en";
const block = z.object({
  id: z.string().max(80).optional(),
  type: z.enum([
    "rich_text",
    "image",
    "hero",
    "banner",
    "product_carousel",
    "category_grid",
    "collection_grid",
    "countdown",
    "testimonials",
    "faq",
    "newsletter",
    "blog_feed",
  ]),
  data: z.record(z.string(), z.unknown()).default({}),
});
const translated = z.object({
  title: z.string().trim().min(1).max(255),
  excerpt: z.string().max(5000).optional().default(""),
  blocks: z.array(block).max(100).default([]),
  seoTitle: z.string().max(255).optional().default(""),
  seoDescription: z.string().max(500).optional().default(""),
});
const common = {
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(180),
  status: z.enum(["draft", "scheduled", "published"]).default("draft"),
  publishAt: z.iso.datetime().nullable().optional(),
  translations: z.object({ en: translated, bn: translated }),
  changeSummary: z.string().max(500).optional(),
};
const pageSchema = z.object({
  ...common,
  template: z.string().max(80).default("standard"),
  version: z.number().int().positive().optional(),
});
const postSchema = z.object({
  ...common,
  type: z.enum(["blog", "lookbook"]).default("blog"),
  categoryId: z.string().length(26).nullable().optional(),
  coverMediaId: z.string().length(26).nullable().optional(),
  version: z.number().int().positive().optional(),
});
const homeSchema = z.object({
  type: z.enum([
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
  ]),
  enabled: z.boolean(),
  displayOrder: z.number().int().min(0),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  config: z.record(z.string(), z.unknown()),
  status: z.enum(["draft", "published"]),
  version: z.number().int().positive().optional(),
});

const menuItem = z.object({
  clientKey: z.string().trim().min(1).max(80),
  parentKey: z.string().trim().min(1).max(80).nullable().optional(),
  targetType: z.enum(["url", "product", "category", "collection", "page"]),
  targetId: z.string().length(26).nullable().optional(),
  url: z.string().max(1000).nullable().optional(),
  labelEn: z.string().trim().min(1).max(180),
  labelBn: z.string().trim().min(1).max(180),
  displayOrder: z.number().int().min(0),
  visible: z.boolean(),
});
const menuSchema = z.object({
  location: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .max(80),
  name: z.string().trim().min(2).max(160),
  status: z.enum(["draft", "published"]),
  items: z.array(menuItem).max(100),
  version: z.number().int().positive().optional(),
});

const safeUrl = z
  .union([z.literal(""), z.string().url().max(1000)])
  .nullable()
  .optional();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const themeSettings = z
  .object({
    primary: color,
    accent: color,
    background: color,
    text: color,
    radius: z.enum(["0rem", "0.25rem", "0.5rem", "0.75rem", "1rem", "1.5rem"]),
    fontHeading: z.enum(["system", "serif", "sans"]).optional(),
    fontBody: z.enum(["system", "serif", "sans"]).optional(),
    logoUrl: safeUrl,
    faviconUrl: safeUrl,
    header: z
      .object({
        sticky: z.boolean().default(true),
        showSearch: z.boolean().default(true),
      })
      .optional(),
    footer: z
      .object({
        showContact: z.boolean().default(true),
        showSocial: z.boolean().default(true),
      })
      .optional(),
    productCard: z
      .object({
        showRating: z.boolean().default(true),
        showQuickAdd: z.boolean().default(false),
      })
      .optional(),
    announcement: z
      .object({
        enabled: z.boolean(),
        textEn: z.string().max(255),
        textBn: z.string().max(255),
        url: safeUrl,
      })
      .optional(),
  })
  .strict();

@Controller("")
export class ContentController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @Get("/storefront/navigation")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.storefrontNavigation(locale(req)),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/storefront/home")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.storefrontHome(locale(req)),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/pages/:slug")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.getPublicPage(
          req.params.slug,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/posts")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.content.listPublicPosts(
        req.query,
        locale(req),
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @Get("/posts/:slug")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.getPublicPost(
          req.params.slug,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/sitemap-data")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.sitemapData(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @ValidateRequest(
    z.object({
      name: z.string().trim().min(2).max(120),
      phone: z.string().trim().max(30).optional().default(""),
      email: z
        .union([z.literal(""), z.email().max(190)])
        .optional()
        .default(""),
      subject: z.string().trim().min(2).max(180),
      message: z.string().trim().min(10).max(10_000),
    }),
  )
  @UseGuards(ContactRateLimitGuard)
  @Post("/contact")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(202).json({
        data: await this.services.content.submitContact(req.body, req),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}

@Controller("admin")
export class AdminContentController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @Get(`/${"pages"}`)
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.content.listAdminContent(
        "page",
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @ValidateRequest(pageSchema)
  @Post(`/${"pages"}`)
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.content.saveContent(
          "page",
          null,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @Get(`/${"pages"}/:id`)
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.getAdminContent(
          "page",
          req.params.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @ValidateRequest(pageSchema.extend({ version: z.number().int().positive() }))
  @Patch(`/${"pages"}/:id`)
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.saveContent(
          "page",
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @Get(`/${"pages"}/:id/revisions`)
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.listRevisions("page", req.params.id),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.publish")
  @ValidateRequest(
    z.object({
      revisionId: z.string().length(26),
      version: z.number().int().positive(),
    }),
  )
  @Post(`/${"pages"}/:id/rollback`)
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.rollbackContent(
          "page",
          req.params.id,
          req.body.revisionId,
          req.body.version,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @Get(`/${"posts"}`)
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.content.listAdminContent(
        "post",
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @ValidateRequest(postSchema)
  @Post(`/${"posts"}`)
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.content.saveContent(
          "post",
          null,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @Get(`/${"posts"}/:id`)
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.getAdminContent(
          "post",
          req.params.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @ValidateRequest(postSchema.extend({ version: z.number().int().positive() }))
  @Patch(`/${"posts"}/:id`)
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.saveContent(
          "post",
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @Get(`/${"posts"}/:id/revisions`)
  route10(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.listRevisions("post", req.params.id),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.publish")
  @ValidateRequest(
    z.object({
      revisionId: z.string().length(26),
      version: z.number().int().positive(),
    }),
  )
  @Post(`/${"posts"}/:id/rollback`)
  route11(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.rollbackContent(
          "post",
          req.params.id,
          req.body.revisionId,
          req.body.version,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @Get("/home-sections")
  route12(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.listHomeAdmin(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @ValidateRequest(homeSchema)
  @Post("/home-sections")
  route13(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.content.saveHomeSection(
          null,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @ValidateRequest(homeSchema.extend({ version: z.number().int().positive() }))
  @Patch("/home-sections/:id")
  route14(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.saveHomeSection(
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @Get("/menus")
  route15(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.listMenusAdmin(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @ValidateRequest(menuSchema)
  @Post("/menus")
  route16(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.content.saveMenu(
          null,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @ValidateRequest(menuSchema.extend({ version: z.number().int().positive() }))
  @Patch("/menus/:id")
  route17(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.saveMenu(
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.manage")
  @Get("/theme")
  route18(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.getThemeAdmin(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("cms.publish")
  @ValidateRequest(
    z.object({
      status: z.enum(["draft", "published"]),
      settings: themeSettings,
      version: z.number().int().positive(),
      sourceId: z.string().length(26).optional(),
    }),
  )
  @Put("/theme")
  route19(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.content.saveTheme(
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
