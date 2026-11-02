import {
  Controller,
  Delete,
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
const webhookSchema = z.object({
  name: z.string().trim().min(2).max(160),
  topics: z.array(z.string().trim().min(2).max(120)).min(1).max(50),
  url: z.string().url().max(1000),
  secret: z.string().min(24).max(500).optional(),
  status: z.enum(["active", "paused", "disabled"]).default("active"),
  version: z.number().int().positive().optional(),
});

@Controller("admin")
export class AdminOperationsController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("audits.view")
  @Get("/audits")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.operations.listAudits(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("reports.view")
  @Get("/reports/summary")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.reportSummary(req.query),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("reports.view")
  @Get("/reports/:report")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.reportData(
          req.params.report,
          req.query,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("reports.view")
  @Get("/exports")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.operations.listExports(
        req.query,
        req.auth.user.id,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("reports.export")
  @ValidateRequest(
    z.object({
      report: z.enum([
        "orders",
        "sales",
        "products",
        "inventory",
        "customers",
        "coupons",
        "payments",
        "returns",
        "profit",
        "audits",
      ]),
      filters: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  @Post("/exports")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(202).json({
        data: await this.services.operations.createExport(
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("reports.view")
  @Get("/exports/:id")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.getExport(req.params.id, req),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("reports.export")
  @Post("/exports/:id/cancel")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.cancelExport(
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("notifications.manage")
  @Get("/notifications/templates")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.operations.listNotificationTemplates(
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("notifications.manage")
  @Get("/notifications/templates/:id")
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.getNotificationTemplate(
          req.params.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("notifications.manage")
  @ValidateRequest(
    z.object({
      subject: z.string().trim().max(255).nullable().optional(),
      body: z.string().trim().min(1).max(20000),
      active: z.boolean(),
      version: z.number().int().positive(),
    }),
  )
  @Patch("/notifications/templates/:id")
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.updateNotificationTemplate(
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
  @Permissions("notifications.manage")
  @ValidateRequest(
    z.object({
      variables: z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean()]),
      ),
    }),
  )
  @Post("/notifications/templates/:id/preview")
  route10(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.previewNotificationTemplate(
          req.params.id,
          req.body.variables,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("notifications.manage")
  @ValidateRequest(
    z.object({
      recipient: z.string().trim().min(3).max(255),
      variables: z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean()]),
      ),
    }),
  )
  @Post("/notifications/templates/:id/test")
  route11(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.status(202).json({
        data: await this.services.operations.testNotificationTemplate(
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
  @Permissions("notifications.manage")
  @Get("/notifications/outbox")
  route12(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.operations.listNotificationOutbox(
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("notifications.manage")
  @Get("/notifications/outbox/:id")
  route13(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.getNotificationDelivery(
          req.params.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("notifications.manage")
  @Post("/notifications/outbox/:id/retry")
  route14(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.retryNotification(
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("webhooks.manage")
  @Get("/webhooks")
  route15(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.listWebhooks(req.query),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("webhooks.manage")
  @ValidateRequest(webhookSchema)
  @Post("/webhooks")
  route16(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.operations.saveWebhook(
          null,
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("webhooks.manage")
  @ValidateRequest(
    webhookSchema.extend({ version: z.number().int().positive() }),
  )
  @Patch("/webhooks/:id")
  route17(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.saveWebhook(
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
  @Permissions("webhooks.manage")
  @Get("/webhooks/:id/deliveries")
  route18(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.operations.listWebhookDeliveries(
        req.params.id,
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("webhooks.manage")
  @Post("/webhooks/:id/test")
  route19(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.testWebhook(
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("webhooks.manage")
  @ValidateRequest(
    z.object({
      secret: z.string().min(24).max(500),
      version: z.number().int().positive(),
    }),
  )
  @Post("/webhooks/:id/rotate-secret")
  route20(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.rotateWebhookSecret(
          req.params.id,
          req.body.secret,
          req.body.version,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("webhooks.manage")
  @Delete("/webhooks/:id")
  route21(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.operations.archiveWebhook(
        req.params.id,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("webhooks.manage")
  @Post("/webhook-deliveries/:id/retry")
  route22(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.retryWebhookDelivery(
          req.params.id,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("customers.view")
  @Get("/contact-messages")
  route23(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.operations.listContactMessages(
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("customers.manage")
  @ValidateRequest(
    z.object({
      status: z.enum(["new", "in_progress", "resolved", "spam"]),
    }),
  )
  @Patch("/contact-messages/:id")
  route24(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.operations.updateContactMessage(
          req.params.id,
          req.body.status,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
