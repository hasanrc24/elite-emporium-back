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
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const couponSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/)
    .min(2)
    .max(80),
  type: z.enum(["percentage", "fixed_cart", "fixed_item", "free_delivery"]),
  amount: money,
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  minimumSpend: money.nullable().optional(),
  maximumSpend: money.nullable().optional(),
  usageLimit: z
    .number()
    .int()
    .positive()
    .max(100_000_000)
    .nullable()
    .optional(),
  perCustomerLimit: z
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .nullable()
    .optional(),
  perItemLimit: z
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .nullable()
    .optional(),
  includeSaleItems: z.boolean().default(true),
  firstOrderOnly: z.boolean().default(false),
  stackable: z.boolean().default(false),
  allowedZones: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  allowedPayments: z
    .array(z.enum(["cod", "bkash"]))
    .max(2)
    .default([]),
  active: z.boolean().default(true),
  includedProductIds: z.array(id).max(10_000).default([]),
  excludedProductIds: z.array(id).max(10_000).default([]),
  includedCategoryIds: z.array(id).max(1_000).default([]),
  excludedCategoryIds: z.array(id).max(1_000).default([]),
  eligibleUserIds: z.array(id).max(10_000).default([]),
  eligiblePhones: z
    .array(z.string().trim().min(10).max(30))
    .max(10_000)
    .default([]),
});

@Controller("admin")
export class AdminCouponController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("promotions.manage")
  @Get("/coupons")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.coupons.listCoupons(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("promotions.manage")
  @ValidateRequest(couponSchema)
  @Post("/coupons")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.status(201).json({
        data: await this.services.coupons.createCoupon(
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
  @Permissions("promotions.manage")
  @Get("/coupons/:id")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.coupons.getCoupon(req.params.id),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("promotions.manage")
  @ValidateRequest(
    couponSchema.and(z.object({ version: z.number().int().positive() })),
  )
  @Patch("/coupons/:id")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.coupons.updateCoupon(
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
  @Permissions("promotions.manage")
  @ValidateRequest(
    z.object({
      version: z.number().int().positive(),
      active: z.boolean(),
    }),
  )
  @Post("/coupons/:id/activation")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.coupons.setCouponActive(
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
  @Permissions("promotions.manage")
  @ValidateRequest(z.object({ version: z.number().int().positive() }))
  @Post("/coupons/:id/archive")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.coupons.archiveCoupon(
        req.params.id,
        req.body.version,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("promotions.manage")
  @Post("/coupons/:id/restore")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.coupons.restoreCoupon(
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("promotions.manage")
  @ValidateRequest(
    z.object({
      code: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]+$/)
        .min(2)
        .max(80),
    }),
  )
  @Post("/coupons/:id/duplicate")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.status(201).json({
        data: await this.services.coupons.duplicateCoupon(
          req.params.id,
          req.body.code,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("promotions.manage")
  @Get("/coupons/:id/usage")
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.coupons.listCouponUsage(
        req.params.id,
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }
}
