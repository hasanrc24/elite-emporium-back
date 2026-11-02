import {
  Controller,
  Get,
  Inject,
  Header,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import type { Request, Response } from "express";
import { money } from "../../lib/money.js";
import { ApplicationServices } from "../../app/application-services.js";
import {
  AccessTokenGuard,
  PermissionGuard,
  Permissions,
  ValidateRequest,
} from "../../app/request-security.js";
import {
  createProductSchema,
  productMoneySchema,
  productSlugSchema,
  updateProductSchema,
} from "./product.schemas.js";

const variationSelections = z.object({
  attributes: z
    .array(
      z.object({
        attributeId: z.string().length(26),
        valueIds: z.array(z.string().length(26)).min(1).max(100),
      }),
    )
    .min(1)
    .max(8),
  skuPrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/)
    .min(1)
    .max(60),
  locale: z.enum(["en", "bn"]).default("en"),
});
const matrixRow = z
  .object({
    signature: z.string().trim().min(1).max(1000),
    attributeValueIds: z.array(z.string().length(26)).min(1).max(8),
    sku: z.string().trim().min(1).max(100),
    barcode: z.string().trim().max(100).nullable().optional(),
    title: z.string().trim().min(1).max(180),
    attributes: z.record(z.string(), z.string()),
    regularPrice: productMoneySchema,
    salePrice: productMoneySchema.nullable().optional(),
    costPrice: productMoneySchema.nullable().optional(),
    saleStartsAt: z.iso.datetime().nullable().optional(),
    saleEndsAt: z.iso.datetime().nullable().optional(),
    stockPolicy: z
      .enum(["deny", "allow_backorder", "preorder", "available"])
      .default("deny"),
    preorderAvailableAt: z.iso.datetime().nullable().optional(),
    preorderMessage: z.string().trim().max(255).nullable().optional(),
    weightGrams: z.number().int().min(0).max(10_000_000).nullable().optional(),
    dimensions: z
      .object({
        lengthCm: z.number().positive().nullable().optional(),
        widthCm: z.number().positive().nullable().optional(),
        heightCm: z.number().positive().nullable().optional(),
      })
      .nullable()
      .optional(),
    // Optional: PATCH /variants/:id must not reset stock when it is omitted.
    initialStock: z.number().int().min(0).max(1_000_000).optional(),
    lowStockThreshold: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .nullable()
      .optional(),
  })
  .superRefine((value, context) => {
    if (
      value.salePrice != null &&
      money(value.salePrice).greaterThanOrEqualTo(money(value.regularPrice))
    )
      context.addIssue({
        code: "custom",
        path: ["salePrice"],
        message: "Sale price must be lower than regular price.",
      });
    if (
      value.saleStartsAt &&
      value.saleEndsAt &&
      Date.parse(value.saleStartsAt) >= Date.parse(value.saleEndsAt)
    )
      context.addIssue({
        code: "custom",
        path: ["saleEndsAt"],
        message: "Sale end must be after sale start.",
      });
  });

/** Permissions beyond catalog.manage that change what a request may see or do. */
const accessOf = (request: Request) => ({
  cost: request.auth.permissions.has("catalog.cost"),
  publish: request.auth.permissions.has("catalog.publish"),
});

const csvImport = z.object({
  csv: z.string().min(1).max(5_000_000),
  dryRun: z.boolean().default(true),
});

@Controller("admin")
export class AdminProductController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get("/products")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.adminProducts.listAdminProducts(
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(createProductSchema)
  @Post("/products")
  routeCreate(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.status(201).json({
        data: await this.services.adminProducts.createProduct(
          req.body,
          req.auth.user.id,
          req,
          accessOf(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.export")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Get("/products/export")
  routeExport(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      const csv = await this.services.productCsv.exportProductsCsv(
        req.query,
        accessOf(req),
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="products.csv"',
      );
      res.send(csv);
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.import", "catalog.manage")
  @ValidateRequest(csvImport)
  @Post("/products/import")
  routeImport(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.productCsv.importProductsCsv(
          req.body,
          req.auth.user.id,
          req.get("idempotency-key"),
          req,
          accessOf(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    z
      .object({
        items: z
          .array(
            z.object({
              id: z.string().length(26),
              version: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(500),
        featured: z.boolean().optional(),
        visibility: z
          .enum(["catalog_search", "catalog", "search", "hidden"])
          .optional(),
        status: z.literal("draft").optional(),
      })
      .refine(
        (value) => value.featured != null || value.visibility || value.status,
        { message: "Choose at least one change." },
      ),
  )
  @Post("/products/bulk")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminProducts.bulkUpdateProducts(
          req.body,
          req.auth.user.id,
          req,
          accessOf(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.view")
  @Get("/products/:id")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminProducts.getAdminProduct(
          req.params.id,
          accessOf(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(updateProductSchema)
  @Patch("/products/:id")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminProducts.updateProduct(
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
          accessOf(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.publish")
  @ValidateRequest(
    z.object({
      version: z.number().int().positive(),
      status: z.enum(["draft", "scheduled", "published"]),
      publishAt: z.iso.datetime().nullable().optional(),
    }),
  )
  @Post("/products/:id/publication")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminProducts.changePublication(
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
          accessOf(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage", "catalog.publish")
  @ValidateRequest(z.object({ version: z.number().int().positive() }))
  @Post("/products/:id/archive")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.adminProducts.archiveProduct(
        req.params.id,
        req.body.version,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage", "catalog.publish")
  @Post("/products/:id/restore")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminProducts.restoreProduct(
          req.params.id,
          req.auth.user.id,
          req,
          accessOf(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    z.object({
      slug: productSlugSchema,
      skuPrefix: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]+$/)
        .min(1)
        .max(80),
      copyStock: z.boolean().default(false),
    }),
  )
  @Post("/products/:id/duplicate")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.status(201).json({
        data: await this.services.adminProducts.duplicateProduct(
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
          accessOf(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(variationSelections)
  @Post("/products/:id/variants/generate-preview")
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.variantMatrix.previewVariantMatrix(
          req.params.id,
          req.body,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    z.object({
      previewToken: z.string().min(40).max(100_000),
      rows: z.array(matrixRow).min(1).max(250),
    }),
  )
  @Post("/products/:id/variants/generate-commit")
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const data = await this.services.variantMatrix.commitVariantMatrix(
        req.params.id,
        req.body,
        req.auth.user.id,
        req.get("idempotency-key"),
        req,
        accessOf(req),
      );
      res.status(201).json({ data, meta: null, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(
    matrixRow.and(
      z.object({
        version: z.number().int().positive(),
        isDefault: z.boolean(),
      }),
    ),
  )
  @Patch("/variants/:id")
  route10(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.variantMatrix.updateVariant(
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
          accessOf(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @ValidateRequest(z.object({ version: z.number().int().positive() }))
  @Post("/variants/:id/archive")
  route11(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.variantMatrix.archiveVariant(
        req.params.id,
        req.body.version,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("catalog.manage")
  @Post("/variants/:id/restore")
  route12(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.variantMatrix.restoreVariant(
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }
}
