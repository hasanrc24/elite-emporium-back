import {
  Controller,
  Get,
  Inject,
  Post,
  Put,
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
const baseMessaging = {
  environment: z.literal("default").default("default"),
  version: z.number().int().positive().nullable().optional(),
};
const messagingSchemas = {
  smtp: z.object({
    ...baseMessaging,
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    username: z.string().max(255).optional(),
    password: z.string().max(1000).optional(),
    from: z.email().max(255),
  }),
  sms: z.object({
    ...baseMessaging,
    url: z.url().max(1000),
    token: z.string().max(2000).optional(),
    tokenHeader: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/)
      .max(100)
      .optional(),
    tokenScheme: z.string().max(30).optional(),
    recipientField: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/)
      .max(80)
      .optional(),
    messageField: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/)
      .max(80)
      .optional(),
  }),
};

@Controller("admin")
export class AdminIntegrationController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @Get("/integrations")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.listIntegrations(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @ValidateRequest(
    z.object({
      environment: z.enum(["sandbox", "live"]),
      username: z.string().trim().min(1).max(255),
      password: z.string().min(1).max(255),
      appKey: z.string().trim().min(1).max(255),
      appSecret: z.string().min(1).max(255),
      version: z.number().int().positive().nullable().optional(),
    }),
  )
  @Put("/integrations/bkash")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.configureBkash(
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @Post("/integrations/bkash/test")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.testBkash(req.auth.user.id, req),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @Post("/integrations/bkash/enable")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.setBkashEnabled(
          true,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @Post("/integrations/bkash/disable")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.setBkashEnabled(
          false,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @ValidateRequest(messagingSchemas["smtp"])
  @Put(`/integrations/${"smtp"}`)
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.configureMessaging(
          "smtp",
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @ValidateRequest(
    z.object({
      environment: z.literal("default").default("default"),
      testRecipient: z.string().optional(),
    }),
  )
  @Post(`/integrations/${"smtp"}/test`)
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.testMessaging(
          "smtp",
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @Post(`/integrations/${"smtp"}/enable`)
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.setMessagingEnabled(
          "smtp",
          true,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @Post(`/integrations/${"smtp"}/disable`)
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.setMessagingEnabled(
          "smtp",
          false,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @ValidateRequest(messagingSchemas["sms"])
  @Put(`/integrations/${"sms"}`)
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.configureMessaging(
          "sms",
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @ValidateRequest(
    z.object({
      environment: z.literal("default").default("default"),
      testRecipient: z.string().trim().min(6).max(30),
    }),
  )
  @Post(`/integrations/${"sms"}/test`)
  route10(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.testMessaging(
          "sms",
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @Post(`/integrations/${"sms"}/enable`)
  route11(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.setMessagingEnabled(
          "sms",
          true,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @Post(`/integrations/${"sms"}/disable`)
  route12(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.integrations.setMessagingEnabled(
          "sms",
          false,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
