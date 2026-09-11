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
  CartContextGuard,
  OptionalAccessTokenGuard,
  ValidateRequest,
} from "../../app/request-security.js";

const customer = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(10).max(30),
  email: z
    .union([z.literal(""), z.email().max(190)])
    .optional()
    .default(""),
});
const address = z.object({
  recipientName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(10).max(30).optional(),
  addressLine: z.string().trim().min(5).max(500),
  area: z.string().trim().max(120).nullable().optional(),
  district: z.string().trim().max(120).nullable().optional(),
  division: z.string().trim().max(120).nullable().optional(),
  postcode: z.string().trim().max(20).nullable().optional(),
  landmark: z.string().trim().max(255).nullable().optional(),
});
const quoteSchema = z.object({
  customer,
  address,
  billingAddress: address.nullable().optional(),
  deliveryCode: z.string().trim().min(1).max(60),
  paymentMethod: z.enum(["cod", "bkash"]).default("cod"),
  locale: z.enum(["en", "bn"]).default("en"),
  note: z.string().trim().max(1000).optional().default(""),
});
const orderSchema = z.object({ quoteId: z.string().length(26) });

@Controller("checkout")
export class CheckoutController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @ValidateRequest(quoteSchema)
  @Post("/quote")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.orders.quote(
          req.cart.id,
          req.auth?.user.id,
          req.body,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}

@Controller("orders")
export class OrderController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @ValidateRequest(orderSchema)
  @Post("/")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.orders.createOrder(
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
      reference: z.string().trim().min(5).max(40),
      phone: z.string().min(10).max(30),
    }),
  )
  @Post("/track")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.orders.trackOrder(
          req.body.reference,
          req.body.phone,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Get("/")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.orders.listOrders(
        req.auth.user.id,
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Get("/:id")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.orders.getOrder(
          req.params.id,
          req.auth.user.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(z.object({ reason: z.string().trim().min(3).max(255) }))
  @Post("/:id/cancel")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.orders.cancelOrder(
          req.params.id,
          req.auth.user.id,
          req.body.reason,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
