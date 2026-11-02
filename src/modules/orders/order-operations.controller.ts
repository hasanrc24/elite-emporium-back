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

const ulid = z.string().length(26);
const confirmationSchema = z.object({
  outcome: z.enum([
    "confirmed",
    "no_answer",
    "wrong_number",
    "customer_cancelled",
    "call_back",
  ]),
  method: z.enum(["call", "manual"]).default("call"),
  note: z.string().trim().max(500).optional(),
  callbackAt: z.coerce.date().optional(),
  version: z.number().int().positive().optional(),
});
const blocklistSchema = z.object({
  type: z.enum(["phone", "email", "ip_prefix"]),
  value: z.string().trim().min(3).max(190),
  reason: z.string().trim().min(3).max(255),
  active: z.boolean().default(true),
  expiresAt: z.coerce.date().nullable().optional(),
});
const tokenSchema = z.object({
  token: z.string().trim().min(30).max(140),
});

@Controller("admin")
export class AdminOrderOperationsController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.confirm")
  @Get("/confirmations")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.confirmations.listConfirmationQueue(
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.confirm")
  @ValidateRequest(z.object({ ids: z.array(ulid).min(1).max(50) }))
  @Post("/confirmations/actions/bulk-confirm")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.confirmations.bulkConfirm(
          req.body.ids,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.confirm")
  @ValidateRequest(confirmationSchema)
  @Post("/confirmations/:id")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.confirmations.recordConfirmation(
          String(req.params.id),
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("risk.view")
  @Get("/risk/blocklist")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.risk.listBlocklist(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("risk.manage")
  @ValidateRequest(blocklistSchema)
  @Post("/risk/blocklist")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.risk.saveBlocklistEntry(
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
  @Permissions("risk.manage")
  @ValidateRequest(blocklistSchema)
  @Patch("/risk/blocklist/:id")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.risk.saveBlocklistEntry(
          String(req.params.id),
          req.body,
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
      tags: z
        .array(
          z
            .string()
            .trim()
            .regex(/^[a-z0-9-]{1,40}$/),
        )
        .max(12),
    }),
  )
  @Patch("/orders/:id/tags")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.adminOrders.updateOrderTags(
          String(req.params.id),
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("orders.view")
  @ValidateRequest(z.object({ ids: z.array(ulid).min(1).max(50) }))
  @Post("/order-documents")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.adminOrders.getOrderDocuments(req.body.ids),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}

@Controller("orders")
export class OrderConfirmationController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @ValidateRequest(tokenSchema)
  @Post("/confirmation/lookup")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.confirmations.lookupConfirmation(
          req.body.token,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @ValidateRequest(tokenSchema)
  @Post("/confirmation")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.confirmations.confirmByToken(
          req.body.token,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}

@Controller("locations")
export class LocationController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @Get("/")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.json({
        data: await this.services.locations.listLocations(),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }
}
