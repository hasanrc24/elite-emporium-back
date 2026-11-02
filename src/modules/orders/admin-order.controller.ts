import {
  Controller,
  Get,
  Inject,
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
const manualOrderSchema = z.object({
  customerId: z.string().length(26).nullable().optional(),
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(10).max(30),
    email: z
      .union([z.literal(""), z.email().max(190)])
      .optional()
      .default(""),
  }),
  address: z.object({
    addressLine: z.string().trim().min(5).max(500),
    area: z.string().max(120).optional(),
    district: z.string().max(120).optional(),
    division: z.string().max(120).optional(),
    postcode: z.string().max(20).optional(),
    landmark: z.string().max(255).optional(),
  }),
  items: z
    .array(
      z.object({
        variantId: z.string().length(26),
        quantity: z.number().int().min(1).max(999),
        unitPrice: z
          .string()
          .regex(/^\d{1,10}(\.\d{1,2})?$/)
          .optional(),
      }),
    )
    .min(1)
    .max(100),
  deliveryCode: z.string().trim().min(1).max(60),
  manualDiscount: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/)
    .default("0.00"),
  discountReason: z.string().trim().max(500).optional(),
  overrideReason: z.string().trim().max(500).optional(),
  note: z.string().trim().max(5000).optional(),
  status: z.enum(["draft", "placed"]).default("draft"),
  locale: z.enum(["en", "bn"]).default("en"),
  channel: z
    .enum(["facebook", "instagram", "whatsapp", "phone", "walk_in", "other"])
    .default("phone"),
  tags: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z0-9-]{1,40}$/),
    )
    .max(12)
    .default([]),
});

@Controller("admin")
export class AdminOrderController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.create")
  @ValidateRequest(manualOrderSchema)
  @Post("/orders")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.adminOrders.createManualOrder(
          req.body,
          req.auth.user.id,
          req.auth.permissions,
          req.get("idempotency-key"),
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.view")
  @Get("/orders")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.adminOrders.listAdminOrders(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.view")
  @Get("/orders/:id")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.adminOrders.getAdminOrder(req.params.id),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.progress")
  @ValidateRequest(
    z.object({
      dimension: z.enum(["order", "fulfillment"]),
      status: z.string().trim().min(1).max(60),
      reason: z.string().trim().min(3).max(500),
      message: z.string().trim().max(255).optional(),
      public: z.boolean().default(true),
      version: z.number().int().positive(),
    }),
  )
  @Post("/orders/:id/transitions")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.adminOrders.transitionOrder(
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
  @Permissions("orders.cancel")
  @ValidateRequest(z.object({ reason: z.string().trim().min(3).max(500) }))
  @Post("/orders/:id/cancel")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.adminOrders.cancelAdminOrder(
          req.params.id,
          req.body.reason,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.edit")
  @ValidateRequest(
    z.object({
      visibility: z.enum(["internal", "customer"]).default("internal"),
      message: z.string().trim().min(1).max(5000),
    }),
  )
  @Post("/orders/:id/notes")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.adminOrders.addOrderNote(
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
  @Permissions("payments.view")
  @Get("/payments")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.adminOrders.listPayments(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.view")
  @Get("/payments/:id")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.adminOrders.getPayment(req.params.id),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.reconcile")
  @ValidateRequest(
    z.object({
      amount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
      collectedAt: z.iso.datetime().optional(),
      reference: z.string().trim().max(190).optional(),
      note: z.string().trim().max(500).optional(),
    }),
  )
  @Post("/payments/:id/cod-collection")
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.adminOrders.collectCod(
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
