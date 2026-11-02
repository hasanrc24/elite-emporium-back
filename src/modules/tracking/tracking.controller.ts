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
  OptionalAccessTokenGuard,
  PermissionGuard,
  Permissions,
  TrackingRateLimitGuard,
  ValidateRequest,
} from "../../app/request-security.js";
import { relayedEventNames } from "./meta-capi.js";

const eventSchema = z.object({
  name: z.enum(relayedEventNames),
  eventId: z.string().trim().min(8).max(100),
  sourceUrl: z.string().max(1000).optional(),
  value: z.union([z.number(), z.string()]).optional(),
  contents: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        quantity: z.number().int().min(1).max(999).default(1),
        price: z.union([z.number(), z.string()]).optional(),
      }),
    )
    .max(50)
    .optional(),
  searchString: z.string().max(200).optional(),
  contentName: z.string().max(200).optional(),
});
const relaySchema = z.object({
  consent: z.boolean(),
  fbp: z.string().max(100).optional(),
  fbc: z.string().max(400).optional(),
  events: z.array(eventSchema).min(1).max(5),
});
const connectSchema = z.object({
  // Omitted when reconnecting: the stored token is kept.
  accessToken: z.string().trim().min(20).max(1000).optional(),
  // From Events Manager → Test events. Used once, for the connection test.
  testEventCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{3,40}$/),
  version: z.number().int().positive().nullable().optional(),
});

/** Browser pixel events relayed to the Conversions API with a shared event ID. */
@Controller("tracking")
export class TrackingController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(TrackingRateLimitGuard, OptionalAccessTokenGuard)
  @ValidateRequest(relaySchema)
  @Post("/events")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(202).json({
        data: await this.services.tracking.recordClientEvents(req.body, req),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}

@Controller("admin")
export class AdminTrackingController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @Get("/integrations/meta-capi/status")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.tracking.getMetaCapiStatus(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("integrations.manage")
  @ValidateRequest(connectSchema)
  @Post("/integrations/meta-capi/connect")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.tracking.connectMetaCapi(
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
