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
  ManualPaymentRateLimitGuard,
  PermissionGuard,
  Permissions,
  ValidateRequest,
} from "../../app/request-security.js";
import { manualWalletProviders } from "./manual-wallet.js";

const submitSchema = z.object({
  reference: z.string().trim().min(5).max(40),
  phone: z.string().trim().min(10).max(30),
  provider: z.enum(manualWalletProviders),
  senderPhone: z.string().trim().min(10).max(30),
  trxId: z.string().trim().min(6).max(30),
});

/** BR-PAY-006: a customer reports a wallet payment against an order. */
@Controller("orders")
export class ManualPaymentController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(ManualPaymentRateLimitGuard)
  @ValidateRequest(submitSchema)
  @Post("/manual-payment")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.manualPayments.submitManualPayment(
          req.body,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}

@Controller("admin")
export class AdminManualPaymentController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.view")
  @Get("/manual-payments")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.manualPayments.listManualPayments(
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.verify_manual")
  @Post("/manual-payments/:id/verify")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.manualPayments.verifyManualPayment(
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("payments.verify_manual")
  @ValidateRequest(z.object({ reason: z.string().trim().min(3).max(500) }))
  @Post("/manual-payments/:id/reject")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.manualPayments.rejectManualPayment(
          req.params.id,
          req.body.reason,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
