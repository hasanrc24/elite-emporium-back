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
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const zoneSchema = z.object({
  code: z
    .string()
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
    .max(60),
  nameEn: z.string().trim().min(1).max(160),
  nameBn: z.string().trim().min(1).max(160),
  matchMode: z.enum(["selector", "structured"]).default("selector"),
  rules: z.record(z.string(), z.unknown()).nullable().optional(),
  priority: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});
const methodSchema = z.object({
  // Optional: a new method without a zone gets its own zone, and its code is
  // generated; an update keeps the zone and code it already has.
  zoneId: z.string().length(26).optional(),
  code: z
    .string()
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
    .max(60)
    .optional(),
  type: z.enum(["flat_rate", "free", "courier"]).default("flat_rate"),
  labelEn: z.string().trim().min(1).max(160),
  labelBn: z.string().trim().min(1).max(160),
  flatRate: money,
  freeThreshold: money.nullable().optional(),
  allowedPayments: z.array(z.enum(["cod", "bkash"])).min(1),
  active: z.boolean().default(true),
  displayOrder: z.number().int().min(0).default(0),
});

const shipmentSchema = z.object({
  orderId: z.string().length(26),
  provider: z.string().trim().max(100).optional(),
  courierName: z.string().trim().min(1).max(160),
  consignmentId: z.string().trim().max(190).optional(),
  trackingUrl: z.string().trim().url().max(1000).nullable().optional(),
  fee: money.nullable().optional(),
  labelMediaId: z.string().length(26).nullable().optional(),
});

@Controller("admin")
export class AdminShippingController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("settings.manage")
  @Get("/shipping")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.shipping.listShippingConfiguration(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("settings.manage")
  @ValidateRequest(zoneSchema)
  @Post("/shipping/zones")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.shipping.saveZone(
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
  @Permissions("settings.manage")
  @ValidateRequest(
    zoneSchema.and(z.object({ version: z.number().int().positive() })),
  )
  @Patch("/shipping/zones/:id")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.shipping.saveZone(
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
  @Permissions("settings.manage")
  @Post("/shipping/zones/:id/archive")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.shipping.archiveShippingResource(
        "zone",
        req.params.id,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("settings.manage")
  @Post("/shipping/zones/:id/restore")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.shipping.restoreShippingResource(
          "zone",
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("settings.manage")
  @ValidateRequest(methodSchema)
  @Post("/shipping/methods")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.shipping.saveMethod(
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
  @Permissions("settings.manage")
  @ValidateRequest(
    methodSchema.and(z.object({ version: z.number().int().positive() })),
  )
  @Patch("/shipping/methods/:id")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.shipping.saveMethod(
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
  @Permissions("settings.manage")
  @Post("/shipping/methods/:id/archive")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.shipping.archiveShippingResource(
        "method",
        req.params.id,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("settings.manage")
  @Post("/shipping/methods/:id/restore")
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.shipping.restoreShippingResource(
          "method",
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.view")
  @Get("/shipments")
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.shipping.listShipments(req.query),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.progress")
  @ValidateRequest(shipmentSchema)
  @Post("/shipments")
  route10(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.shipping.createShipment(
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.progress")
  @ValidateRequest(
    z.object({
      status: z
        .enum([
          "created",
          "picked_up",
          "in_transit",
          "out_for_delivery",
          "delivered",
          "cancelled",
          "failed",
        ])
        .optional(),
      courierName: z.string().trim().max(160).optional(),
      consignmentId: z.string().trim().max(190).nullable().optional(),
      trackingUrl: z.string().trim().url().max(1000).nullable().optional(),
      fee: money.nullable().optional(),
      message: z.string().trim().max(500).optional(),
      version: z.number().int().positive(),
    }),
  )
  @Patch("/shipments/:id")
  route11(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.shipping.updateShipment(
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
