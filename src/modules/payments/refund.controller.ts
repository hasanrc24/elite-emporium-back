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
const moneyValue = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const createRefundSchema = z.object({
  amount: moneyValue,
  reason: z.string().trim().min(3).max(500),
  method: z.enum(["manual", "bkash"]),
  returnId: z.string().length(26).nullable().optional(),
  sku: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(1000).optional(),
});

@Controller("admin")
export class AdminRefundController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.view")
  @Get("/refunds")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.refunds.listRefunds(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.view")
  @Get("/refunds/:id")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.refunds.getRefund(req.params.id),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.view")
  @Get("/payments/:id/refund-capacity")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.refunds.getPaymentRefundCapacity(
          req.params.id,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.refund")
  @ValidateRequest(createRefundSchema)
  @Post("/payments/:id/refunds")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const data = await this.services.refunds.createRefund(
        req.params.id,
        req.body,
        req.auth.user.id,
        req.get("idempotency-key"),
        req,
      );
      res.status(201).json({ data, meta: null, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.refund")
  @ValidateRequest(
    z.object({
      reference: z.string().trim().min(1).max(190),
      completedAt: z.iso.datetime().optional(),
      note: z.string().trim().max(1000).optional(),
    }),
  )
  @Post("/refunds/:id/complete")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.refunds.completeManualRefund(
          req.params.id,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.refund")
  @ValidateRequest(
    z.object({
      reason: z.string().trim().min(3).max(500),
    }),
  )
  @Post("/refunds/:id/cancel")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.refunds.cancelRefund(
          req.params.id,
          req.body.reason,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.reconcile")
  @Post("/refunds/:id/reconcile")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.refunds.reconcileBkashRefund(
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
