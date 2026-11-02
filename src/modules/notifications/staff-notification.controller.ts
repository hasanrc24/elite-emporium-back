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

/** The signed-in staff member's own dashboard alerts (BR-NOTIFY-001). */
@Controller("admin")
export class StaffNotificationController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("admin.access")
  @ValidateRequest(
    z.object({
      status: z.enum(["all", "unread"]).default("all"),
      category: z
        .string()
        .trim()
        .regex(/^[a-z_]{1,40}$/)
        .optional(),
      page: z.coerce.number().int().min(1).max(100_000).optional(),
      pageSize: z.coerce.number().int().min(1).max(50).optional(),
    }),
    "query",
  )
  @Get("/inbox")
  list(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result =
        await this.services.staffNotifications.listStaffNotifications(
          req.auth,
          req.query,
        );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("admin.access")
  @Get("/inbox/summary")
  summary(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      // Polled by the bell; never let an intermediary serve a stale count.
      res.set("cache-control", "no-store");
      res.json({
        data: await this.services.staffNotifications.staffNotificationSummary(
          req.auth,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("admin.access")
  @ValidateRequest(
    z.object({ before: z.string().datetime({ offset: true }).optional() }),
  )
  @Post("/inbox/read-all")
  readAll(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.staffNotifications.markAllStaffNotificationsRead(
          req.auth,
          req.body,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("admin.access")
  @ValidateRequest(z.object({ read: z.boolean() }))
  @Patch("/inbox/:id")
  update(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.staffNotifications.setStaffNotificationRead(
          req.auth,
          String(req.params.id),
          req.body.read,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
