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
@Controller("admin")
export class AdminCustomerController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("customers.view")
  @Get("/customers")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.customers.listCustomers(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("customers.view")
  @Get("/customers/:id")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.customers.getCustomer(req.params.id),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("customers.manage")
  @ValidateRequest(
    z.object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      email: z.string().trim().email().max(190).nullable().optional(),
      locale: z.enum(["en", "bn"]).optional(),
      status: z.enum(["active", "disabled"]).optional(),
      riskLevel: z.enum(["normal", "review", "blocked"]).optional(),
      reason: z.string().trim().min(3).max(500),
      customerMessage: z.string().trim().max(500).optional(),
      version: z.number().int().positive(),
    }),
  )
  @Patch("/customers/:id")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.customers.updateCustomer(
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
  @Permissions("customers.manage")
  @ValidateRequest(
    z.object({
      category: z.enum(["support", "risk", "operations"]).default("support"),
      message: z.string().trim().min(1).max(5000),
    }),
  )
  @Post("/customers/:id/notes")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.customers.addCustomerNote(
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
  @Permissions("customers.view")
  @Get("/privacy-requests")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.privacy.listAdminPrivacyRequests(
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("customers.view")
  @Get("/privacy-requests/:id")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.privacy.getAdminPrivacyRequest(req.params.id),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("customers.manage")
  @ValidateRequest(
    z.object({
      status: z.enum(["under_review", "approved", "rejected", "completed"]),
      version: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500).optional(),
      note: z.string().trim().max(1000).optional(),
      customerMessage: z.string().trim().max(500).optional(),
      confirmation: z.string().trim().max(80).optional(),
    }),
  )
  @Post("/privacy-requests/:id/transitions")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.privacy.transitionPrivacyRequest(
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
