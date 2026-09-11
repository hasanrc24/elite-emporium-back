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
  CartContextGuard,
  OptionalAccessTokenGuard,
  ValidateRequest,
} from "../../app/request-security.js";

@Controller("payments")
export class PaymentController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @ValidateRequest(z.object({ quoteId: z.string().length(26) }))
  @Post("/bkash/create")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.payments.startBkashPayment(
          req.cart.id,
          req.auth?.user.id,
          req.body,
          req.get("idempotency-key"),
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @ValidateRequest(
    z.object({
      paymentID: z.string().trim().min(1).max(190),
      status: z.enum(["success", "failure", "cancel"]),
    }),
    "query",
  )
  @Get("/bkash/callback")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.payments.processBkashCallback(
          req.query.paymentID,
          req.query.status,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @ValidateRequest(
    z.object({
      attemptId: z.string().length(26),
      recoveryToken: z.string().min(32).max(200),
      callbackStatus: z
        .enum(["success", "failure", "cancel"])
        .nullable()
        .optional(),
    }),
  )
  @Post("/bkash/recover")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.payments.recoverBkashPayment(req.body),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
