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
const version = z.number().int().positive();

@Controller("admin")
export class AdminReturnController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("adminReturns.view")
  @Get("/returns")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.adminReturns.listAdminReturns(
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("adminReturns.view")
  @Get("/returns/:id")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminReturns.getAdminReturn(req.params.id),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("adminReturns.manage")
  @ValidateRequest(
    z.object({
      version,
      message: z.string().trim().max(500).optional(),
      note: z.string().trim().max(1000).optional(),
      public: z.boolean().default(true),
    }),
  )
  @Post("/returns/:id/review")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminReturns.startReview(
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
  @Permissions("adminReturns.manage")
  @ValidateRequest(
    z.object({
      version,
      refundAmount: moneyValue.nullable().optional(),
      message: z.string().trim().max(500).optional(),
      note: z.string().trim().max(1000).optional(),
    }),
  )
  @Post("/returns/:id/approve")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminReturns.approveReturn(
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
  @Permissions("adminReturns.manage")
  @ValidateRequest(
    z.object({
      version,
      reason: z.string().trim().min(3).max(500),
      message: z.string().trim().max(500).optional(),
      internalNote: z.string().trim().max(1000).optional(),
    }),
  )
  @Post("/returns/:id/reject")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminReturns.rejectReturn(
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
  @Permissions("adminReturns.manage")
  @ValidateRequest(
    z.object({
      version,
      courier: z.string().trim().max(160).optional(),
      trackingNumber: z.string().trim().max(190).optional(),
      trackingUrl: z.string().url().max(1000).optional(),
      message: z.string().trim().max(500).optional(),
    }),
  )
  @Post("/returns/:id/in-transit")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminReturns.markReturnInTransit(
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
  @Permissions("adminReturns.manage")
  @ValidateRequest(
    z.object({
      version,
      receivedAt: z.iso.datetime().optional(),
      message: z.string().trim().max(500).optional(),
      note: z.string().trim().max(1000).optional(),
    }),
  )
  @Post("/returns/:id/receive")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminReturns.receiveReturn(
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
  @Permissions("adminReturns.manage")
  @ValidateRequest(
    z.object({
      version,
      publicMessage: z.string().trim().max(500).optional(),
      items: z
        .array(
          z
            .object({
              returnItemId: z.string().length(26),
              condition: z.enum([
                "new",
                "opened",
                "used",
                "damaged",
                "defective",
                "unsellable",
              ]),
              restock: z.boolean(),
              locationId: z.string().length(26).nullable().optional(),
              note: z.string().trim().max(500).optional(),
            })
            .superRefine((value, context) => {
              if (value.restock && !value.locationId)
                context.addIssue({
                  code: "custom",
                  path: ["locationId"],
                  message: "Choose a stock location when restocking.",
                });
            }),
        )
        .min(1)
        .max(50),
    }),
  )
  @Post("/returns/:id/inspect")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminReturns.inspectReturn(
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
  @Permissions("adminReturns.manage")
  @Permissions("payments.refund")
  @ValidateRequest(
    z.object({
      paymentId: z.string().length(26),
      amount: moneyValue,
      method: z.enum(["manual", "bkash"]),
      reason: z.string().trim().min(3).max(500),
      sku: z.string().trim().min(1).max(100).optional(),
      note: z.string().trim().max(1000).optional(),
    }),
  )
  @Post("/returns/:id/refund")
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const data = await this.services.refunds.createRefund(
        req.body.paymentId,
        { ...req.body, returnId: req.params.id },
        req.auth.user.id,
        req.get("idempotency-key"),
        req,
      );
      res.status(201).json({ data, meta: null, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("adminReturns.manage")
  @ValidateRequest(
    z.object({
      version,
      items: z
        .array(
          z.object({
            variantId: z.string().length(26),
            quantity: z.number().int().min(1).max(999),
          }),
        )
        .min(1)
        .max(50),
      note: z.string().trim().max(1000).optional(),
    }),
  )
  @Post("/returns/:id/exchange")
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.status(201).json({
        data: await this.services.adminReturns.createExchangeDraft(
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
  @Permissions("adminReturns.manage")
  @ValidateRequest(
    z.object({ version, message: z.string().trim().max(500).optional() }),
  )
  @Post("/returns/:id/complete")
  route10(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.adminReturns.completeReturn(
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
  @Permissions("adminReturns.manage")
  @ValidateRequest(
    z.object({
      type: z.string().trim().min(1).max(100),
      message: z.string().trim().min(1).max(500),
      public: z.boolean().default(false),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
  )
  @Post("/returns/:id/events")
  route11(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.status(201).json({
        data: await this.services.adminReturns.addReturnEvent(
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
}
