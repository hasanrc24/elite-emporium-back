import {
  Controller,
  Get,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import type { Request, Response } from "express";
import { ApplicationServices } from "../../app/application-services.js";
import {
  AccessTokenGuard,
  PermissionGuard,
  Permissions,
  ValidateRequest,
} from "../../app/request-security.js";
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(180);
const id = z.string().length(26);
const localized = z.object({
  en: z.object({
    name: z.string().trim().min(1).max(180),
    description: z.string().max(20_000).default(""),
    seoTitle: z.string().max(255).nullable().optional(),
    seoDescription: z.string().max(500).nullable().optional(),
  }),
  bn: z.object({
    name: z.string().trim().min(1).max(180),
    description: z.string().max(20_000).default(""),
    seoTitle: z.string().max(255).nullable().optional(),
    seoDescription: z.string().max(500).nullable().optional(),
  }),
});
const base = {
  slug,
  mediaId: id.nullable().optional(),
  active: z.boolean().default(true),
  displayOrder: z.number().int().min(0).default(0),
  translations: localized,
};
const schemas = {
  categories: z.object({ ...base, parentId: id.nullable().optional() }),
  collections: z
    .object({
      ...base,
      startsAt: z.iso.datetime().nullable().optional(),
      endsAt: z.iso.datetime().nullable().optional(),
    })
    .refine(
      (value) =>
        !value.startsAt || !value.endsAt || value.startsAt < value.endsAt,
      { path: ["endsAt"], message: "End must be after start." },
    ),
  brands: z.object(base),
};

const attributeValue = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(120),
  value: z.string().trim().min(1).max(180),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  displayOrder: z.number().int().min(0).default(0),
  translations: z.object({
    en: z.object({ label: z.string().trim().min(1).max(160) }),
    bn: z.object({ label: z.string().trim().min(1).max(160) }),
  }),
});
const attributeSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(100),
  type: z.enum(["select", "color", "text"]),
  filterable: z.boolean().default(true),
  variationCapable: z.boolean().default(true),
  displayOrder: z.number().int().min(0).default(0),
  translations: z.object({
    en: z.object({ label: z.string().trim().min(1).max(160) }),
    bn: z.object({ label: z.string().trim().min(1).max(160) }),
  }),
  values: z.array(attributeValue).max(250).default([]),
});

@Controller("admin")
export class AdminTaxonomyController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get(`/${"categories"}`)
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.taxonomies.listTaxonomies(
        "categories",
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(schemas["categories"])
  @Post(`/${"categories"}`)
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.taxonomies.createTaxonomy(
          "categories",
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get(`/${"categories"}/:id`)
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.getTaxonomy(
          "categories",
          req.params.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    schemas["categories"].and(
      z.object({ version: z.number().int().positive() }),
    ),
  )
  @Patch(`/${"categories"}/:id`)
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.updateTaxonomy(
          "categories",
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
  @Permissions("catalog.manage")
  @Post(`/${"categories"}/:id/archive`)
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.taxonomies.archiveTaxonomy(
        "categories",
        req.params.id,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @Post(`/${"categories"}/:id/restore`)
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.restoreTaxonomy(
          "categories",
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    z.object({
      items: z
        .array(
          z.object({
            id,
            displayOrder: z.number().int().min(0),
            version: z.number().int().positive(),
          }),
        )
        .min(1)
        .max(500),
    }),
  )
  @Post(`/${"categories"}/reorder`)
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.taxonomies.reorderTaxonomies(
        "categories",
        req.body.items,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get(`/${"collections"}`)
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.taxonomies.listTaxonomies(
        "collections",
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(schemas["collections"])
  @Post(`/${"collections"}`)
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.taxonomies.createTaxonomy(
          "collections",
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get(`/${"collections"}/:id`)
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.getTaxonomy(
          "collections",
          req.params.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    schemas["collections"].and(
      z.object({ version: z.number().int().positive() }),
    ),
  )
  @Patch(`/${"collections"}/:id`)
  route10(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.updateTaxonomy(
          "collections",
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
  @Permissions("catalog.manage")
  @Post(`/${"collections"}/:id/archive`)
  route11(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.taxonomies.archiveTaxonomy(
        "collections",
        req.params.id,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @Post(`/${"collections"}/:id/restore`)
  route12(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.restoreTaxonomy(
          "collections",
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    z.object({
      items: z
        .array(
          z.object({
            id,
            displayOrder: z.number().int().min(0),
            version: z.number().int().positive(),
          }),
        )
        .min(1)
        .max(500),
    }),
  )
  @Post(`/${"collections"}/reorder`)
  route13(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.taxonomies.reorderTaxonomies(
        "collections",
        req.body.items,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get(`/${"brands"}`)
  route14(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.taxonomies.listTaxonomies(
        "brands",
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(schemas["brands"])
  @Post(`/${"brands"}`)
  route15(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.taxonomies.createTaxonomy(
          "brands",
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get(`/${"brands"}/:id`)
  route16(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.getTaxonomy(
          "brands",
          req.params.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    schemas["brands"].and(z.object({ version: z.number().int().positive() })),
  )
  @Patch(`/${"brands"}/:id`)
  route17(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.updateTaxonomy(
          "brands",
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
  @Permissions("catalog.manage")
  @Post(`/${"brands"}/:id/archive`)
  route18(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.taxonomies.archiveTaxonomy(
        "brands",
        req.params.id,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @Post(`/${"brands"}/:id/restore`)
  route19(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.restoreTaxonomy(
          "brands",
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    z.object({
      items: z
        .array(
          z.object({
            id,
            displayOrder: z.number().int().min(0),
            version: z.number().int().positive(),
          }),
        )
        .min(1)
        .max(500),
    }),
  )
  @Post(`/${"brands"}/reorder`)
  route20(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.taxonomies.reorderTaxonomies(
        "brands",
        req.body.items,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get("/attributes")
  route21(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.listAdminAttributes(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(attributeSchema)
  @Post("/attributes")
  route22(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.taxonomies.createAttribute(
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get("/attributes/:id/usage")
  route23(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.taxonomies.attributeUsage(req.params.id),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
