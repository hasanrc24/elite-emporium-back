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
import { env } from "../../config/env.js";
import type { Request, Response } from "express";
import { ApplicationServices } from "../../app/application-services.js";
import {
  AccessTokenGuard,
  PermissionGuard,
  Permissions,
  UploadSingleFile,
  ValidateRequest,
} from "../../app/request-security.js";
import { MediaAsset } from "../../db/models.js";
import { AppError } from "../../lib/errors.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import {
  readMedia,
  signPrivateMedia,
  verifyPrivateMediaSignature,
} from "./media.storage.js";

@Controller("admin/media")
export class AdminMediaController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("media.manage")
  @Get("/")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const { page, pageSize, limit, offset } = pagination(req.query);
      const result = await MediaAsset.findAndCountAll({
        limit,
        offset,
        order: [["createdAt", "DESC"]],
      });
      res.json({
        ...pageEnvelope(
          {
            rows: result.rows.map(this.services.media.mediaDto),
            count: result.count,
          },
          page,
          pageSize,
        ),
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("media.manage")
  @Get("/:id/status")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const asset = await MediaAsset.findByPk(String(req.params.id));
      if (!asset) throw AppError.notFound("Media asset not found.");
      res.json({
        data: this.services.media.mediaDto(asset),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("media.manage")
  @Get("/:id/usage")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.media.mediaUsage(String(req.params.id)),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("media.manage")
  @UploadSingleFile()
  @Post("/upload")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const uploadedFile = req.file;
      const privacy = req.body.privacy === "private" ? "private" : "public";
      const data = await this.services.media.uploadMedia({
        file: uploadedFile,
        privacy,
        altText: req.body.altText,
        actorId: req.auth.user.id,
        request: req,
        purpose: "library",
      });
      res.status(201).json({ data, meta: null, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("media.manage")
  @ValidateRequest(
    z.object({
      altText: z.string().trim().max(500).nullable().optional(),
      privacy: z.enum(["public", "private"]).optional(),
    }),
  )
  @Patch("/:id")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.media.updateMedia(
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
  @Permissions("media.manage")
  @Delete("/:id")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.media.archiveMedia(
          String(req.params.id),
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("media.manage")
  @Post("/:id/signed-url")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const asset = await MediaAsset.findByPk(String(req.params.id));
      if (!asset || asset.privacy !== "private" || asset.status !== "ready")
        throw AppError.notFound("Private media asset not found.");
      const expiresAt =
        Math.floor(Date.now() / 1000) + env.MEDIA_PRIVATE_URL_TTL_SECONDS;
      const signature = signPrivateMedia(asset.id, expiresAt);
      res.json({
        data: {
          url: `${env.API_BASE_PATH}/media/${asset.id}/download?expires=${expiresAt}&signature=${encodeURIComponent(signature)}`,
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        },
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }
}

@Controller("media")
export class MediaController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard)
  @UploadSingleFile()
  @Post("/upload")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const request = /** @type {any} */ req;
      const purpose = req.body.purpose === "return" ? "return" : "review";
      const data = await this.services.media.uploadMedia({
        file: request.file,
        privacy: purpose === "return" ? "private" : "public",
        altText: req.body.altText,
        actorId: req.auth.user.id,
        request: req,
        purpose,
      });
      res.status(201).json({ data, meta: null, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Post("/:id/signed-url")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const asset = await MediaAsset.findByPk(String(req.params.id));
      if (
        !asset ||
        asset.privacy !== "private" ||
        asset.status !== "ready" ||
        (asset.uploaderId !== req.auth.user.id &&
          !req.auth.permissions.has("media.manage"))
      )
        throw AppError.notFound("Private media asset not found.");
      const expiresAt =
        Math.floor(Date.now() / 1000) + env.MEDIA_PRIVATE_URL_TTL_SECONDS;
      const signature = signPrivateMedia(asset.id, expiresAt);
      res.json({
        data: {
          url: `${env.API_BASE_PATH}/media/${asset.id}/download?expires=${expiresAt}&signature=${encodeURIComponent(signature)}`,
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        },
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @Get("/:id/download")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const asset = await MediaAsset.findByPk(String(req.params.id));
      if (
        !asset ||
        asset.privacy !== "private" ||
        asset.status !== "ready" ||
        !verifyPrivateMediaSignature(
          asset.id,
          req.query.expires,
          req.query.signature,
        )
      )
        throw AppError.notFound("Private media asset not found.");
      const buffer = await readMedia(asset.storageKey);
      res.setHeader("Content-Type", asset.mimeType);
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${String(asset.originalName).replace(/["\r\n]/g, "_")}"`,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.end(buffer);
    })(request, response);
  }
}
