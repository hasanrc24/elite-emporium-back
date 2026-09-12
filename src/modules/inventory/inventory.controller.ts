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
const id = z.string().length(26);
const adjustment = z
  .object({
    variantId: id,
    locationId: id,
    delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    countedQuantity: z.number().int().min(0).max(1_000_000).optional(),
    lowStockThreshold: z.number().int().min(0).max(1_000_000).optional(),
    reason: z.enum([
      "purchase_receipt",
      "manual_correction",
      "damage",
      "loss",
      "return_restock",
      "stock_count",
      "initial_stock",
      "other",
    ]),
    note: z.string().trim().max(500).optional(),
    version: z.number().int().positive(),
  })
  .refine(
    (value) => (value.delta == null) !== (value.countedQuantity == null),
    { message: "Provide either delta or countedQuantity.", path: ["delta"] },
  );
const location = z.object({
  code: z
    .string()
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
    .max(60),
  name: z.string().trim().min(1).max(160),
  address: z.record(z.string(), z.unknown()).nullable().optional(),
  active: z.boolean().default(true),
});

@Controller("admin")
export class AdminInventoryController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("inventory.view")
  @Get("/inventory/levels")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.inventory.listLevels(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("inventory.view")
  @Get("/inventory/low-stock")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.inventory.listLevels({
        ...req.query,
        lowStock: "true",
      });
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("inventory.view")
  @Get("/inventory/movements")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.inventory.listMovements(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }





  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("inventory.adjust")
  @ValidateRequest(adjustment)
  @Post("/inventory/adjustments")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.inventory.adjustInventory(
          req.body,
          req.auth.user.id,
          req.get("idempotency-key"),
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("inventory.adjust")
  @ValidateRequest(adjustment)
  @Post("/inventory/reconciliations")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.inventory.adjustInventory(
          req.body,
          req.auth.user.id,
          req.get("idempotency-key"),
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("inventory.view")
  @Get("/inventory/locations")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.inventory.listLocations(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("inventory.adjust")
  @ValidateRequest(location)
  @Post("/inventory/locations")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.inventory.createLocation(
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("inventory.adjust")
  @ValidateRequest(
    location.and(z.object({ version: z.number().int().positive() })),
  )
  @Patch("/inventory/locations/:id")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.inventory.updateLocation(
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
