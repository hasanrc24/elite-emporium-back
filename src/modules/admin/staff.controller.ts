import {
  Controller,
  Delete,
  Get,
  Inject,
  Patch,
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
import { requireRequestPermission } from "../../app/middleware/authenticate.js";
const id = z.string().length(26);

const roleSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]*$/)
    .min(2)
    .max(60),
  name: z.string().trim().min(2).max(100),
  permissionIds: z.array(id).max(500).default([]),
});

@Controller("admin")
export class AdminStaffController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("staff.view")
  @Get("/staff")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.staff.listStaff(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  // PermissionGuard holds a single key per handler (stacked @Permissions
  // overwrite each other); roles.manage is enforced in the handler below.
  @Permissions("staff.manage")
  @ValidateRequest(
    z.object({
      name: z.string().trim().min(2).max(120),
      phone: z.string().trim().max(30).nullable().optional(),
      email: z.email().max(190).nullable().optional(),
      locale: z.enum(["en", "bn"]).default("en"),
      roleIds: z.array(id).min(1).max(20),
    }),
  )
  @Post("/staff")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      requireRequestPermission(req, "roles.manage");
      res.status(201).json({
        data: await this.services.staff.createStaff(
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
  @Permissions("staff.view")
  @Get("/staff/:id")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.staff.getStaff(req.params.id),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("staff.manage")
  @ValidateRequest(
    z.object({
      name: z.string().trim().min(2).max(120),
      phone: z.string().trim().max(30).nullable(),
      email: z.union([z.email().max(190), z.null()]),
      locale: z.enum(["en", "bn"]),
      status: z.enum(["active", "disabled"]),
      version: z.number().int().positive(),
    }),
  )
  @Patch("/staff/:id")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.staff.updateStaffProfile(
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
  @Permissions("roles.manage")
  @ValidateRequest(
    z.object({
      version: z.number().int().positive(),
      roleIds: z.array(id).min(1).max(20),
      overrides: z
        .array(
          z.object({
            permissionId: id,
            allow: z.boolean(),
            reason: z.string().trim().min(3).max(255),
          }),
        )
        .max(500)
        .default([]),
      reason: z.string().trim().min(3).max(500),
    }),
  )
  @Put("/staff/:id/access")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.staff.updateStaffAccess(
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
  @Permissions("staff.manage")
  @Post("/staff/:id/password-reset")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.staff.resetStaffPassword(
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
  @Permissions("staff.manage")
  @Get("/staff/:id/sessions")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.staff.listStaffSessions(
          req.params.id,
          req.auth.user.id,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("staff.manage")
  @Delete("/staff/:id/sessions/:sessionId")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.staff.revokeStaffSession(
        req.params.id,
        req.params.sessionId,
        req.auth.user.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("roles.manage")
  @Get("/permissions")
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.roles.listPermissions(),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("staff.view")
  @Get("/roles")
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.roles.listRoles(),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("roles.manage")
  @ValidateRequest(roleSchema)
  @Post("/roles")
  route10(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.status(201).json({
        data: await this.services.roles.createRole(
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
  @Permissions("roles.manage")
  @ValidateRequest(
    roleSchema.omit({ key: true }).and(
      z.object({
        version: z.number().int().positive(),
        active: z.boolean(),
        reason: z.string().trim().min(3).max(500),
      }),
    ),
  )
  @Patch("/roles/:id")
  route11(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.roles.updateRole(
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
  @Permissions("roles.manage")
  @ValidateRequest(z.object({ version: z.number().int().positive() }))
  @Post("/roles/:id/archive")
  route12(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.roles.archiveRole(
          req.params.id,
          req.body.version,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("roles.manage")
  @Get("/roles/owner-invariant")
  route13(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      res.json({
        data: await this.services.roles.ownerInvariantSummary(req.auth.user.id),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }
}
