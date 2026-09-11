import { Controller, Get, Put, Req, Res, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { Request, Response } from "express";
import {
  AccessTokenGuard,
  PermissionGuard,
  Permissions,
  ValidateRequest,
} from "../../app/request-security.js";
import {
  getPublicSettings,
  getSettingGroup,
  listSettingGroups,
  updateSettingGroup,
} from "./settings.service.js";

@Controller("admin/settings")
export class AdminSettingsController {
  constructor() {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("settings.manage")
  @Get("/")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await listSettingGroups(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("settings.manage")
  @Get("/:key")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await getSettingGroup(String(req.params.key)),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("settings.manage")
  @ValidateRequest(
    z.object({ value: z.unknown(), version: z.number().int().min(0) }),
  )
  @Put("/:key")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await updateSettingGroup(
          String(req.params.key),
          req.body.value,
          req.body.version,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}

@Controller("storefront")
export class StorefrontController {
  constructor() {}

  @Get("/settings")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await getPublicSettings(),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
