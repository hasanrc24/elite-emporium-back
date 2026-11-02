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

const synonymSchema = z.object({
  term: z.string().trim().min(2).max(80),
  synonyms: z.array(z.string().trim().min(2).max(80)).min(1).max(30),
  active: z.boolean().default(true),
});

@Controller("admin/search")
export class AdminSearchController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("search.manage")
  @Get("/synonyms")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.search.listSynonyms(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("search.manage")
  @ValidateRequest(synonymSchema)
  @Post("/synonyms")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.search.saveSynonym(
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
  @Permissions("search.manage")
  @ValidateRequest(synonymSchema)
  @Patch("/synonyms/:id")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.search.saveSynonym(
          String(req.params.id),
          req.body,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("search.manage")
  @Delete("/synonyms/:id")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.search.deleteSynonym(
          String(req.params.id),
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("search.manage")
  @Get("/misses")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.search.listSearchMisses(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }
}
