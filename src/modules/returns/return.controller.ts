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
  GuestReturnRateLimitGuard,
  OptionalAccessTokenGuard,
  UploadSingleFile,
  ValidateRequest,
} from "../../app/request-security.js";
const guestCredentials = z.object({
  orderReference: z.string().trim().min(5).max(40),
  phone: z.string().trim().min(10).max(30),
});
const createReturnSchema = z
  .object({
    orderId: z.string().length(26).optional(),
    orderReference: z.string().trim().min(5).max(40).optional(),
    phone: z.string().trim().min(10).max(30).optional(),
    type: z.enum(["return", "exchange"]),
    resolution: z.enum(["refund", "exchange"]),
    reason: z.string().trim().min(3).max(255),
    customerNote: z.string().trim().max(5000).optional(),
    items: z
      .array(
        z.object({
          orderItemId: z.string().length(26),
          quantity: z.number().int().min(1).max(999),
          reason: z.string().trim().min(3).max(255).optional(),
        }),
      )
      .min(1)
      .max(50),
    mediaIds: z.array(z.string().length(26)).max(10).default([]),
  })
  .superRefine((value, context) => {
    if (!value.orderId && (!value.orderReference || !value.phone))
      context.addIssue({
        code: "custom",
        path: ["orderReference"],
        message: "Order reference and phone are required for a guest return.",
      });
  });

@Controller("returns")
export class ReturnController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(z.object({ orderId: z.string().length(26) }), "query")
  @Get("/eligibility")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.returns.getReturnEligibility({
          orderId: String(req.query.orderId),
          userId: req.auth.user.id,
        }),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @ValidateRequest(guestCredentials)
  @UseGuards(GuestReturnRateLimitGuard)
  @Post("/guest-eligibility")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.returns.getReturnEligibility({
          orderReference: req.body.orderReference,
          phone: req.body.phone,
          userId: null,
        }),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @ValidateRequest(
    guestCredentials.extend({
      altText: z.string().trim().max(500).optional(),
    }),
  )
  @UseGuards(GuestReturnRateLimitGuard)
  @UploadSingleFile()
  @Post("/guest-upload")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const request = /** @type {any} */ req;
      const order = await this.services.returns.verifyGuestReturnUpload(
        req.body.orderReference,
        req.body.phone,
      );
      const data = await this.services.media.uploadMedia({
        file: request.file,
        privacy: "private",
        altText: req.body.altText,
        actorId: null,
        request: req,
        purpose: "return",
        metadata: { guestOrderId: order.id },
      });
      res.status(201).json({ data, meta: null, requestId: req.id });
    })(request, response);
  }

  @ValidateRequest(
    guestCredentials.extend({
      returnReference: z.string().trim().min(5).max(40).optional(),
    }),
  )
  @UseGuards(GuestReturnRateLimitGuard)
  @Post("/guest-lookup")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.returns.guestLookup(req.body),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(OptionalAccessTokenGuard)
  @ValidateRequest(createReturnSchema)
  @Post("/")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const data = await this.services.returns.createReturn(
        req.body,
        req.auth?.user.id || null,
        req.get("idempotency-key"),
        req,
      );
      res.status(201).json({ data, meta: null, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Get("/")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.returns.listReturns(
        req.auth.user.id,
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Get("/:id")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.returns.getReturn(
          req.params.id,
          req.auth.user.id,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(OptionalAccessTokenGuard)
  @ValidateRequest(
    z.object({
      version: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
      orderReference: z.string().trim().min(5).max(40).optional(),
      phone: z.string().trim().min(10).max(30).optional(),
    }),
  )
  @Post("/:id/cancel")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.returns.cancelReturn(
          req.params.id,
          req.body,
          req.auth?.user.id || null,
          req,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }
}
