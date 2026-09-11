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
const reviewBody = z.object({
  productId: z.string().length(26),
  orderItemId: z.string().length(26),
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(180).optional().default(""),
  body: z.string().trim().min(1).max(5000),
  mediaIds: z.array(z.string().length(26)).max(5).default([]),
});

@Controller("")
export class ReviewController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @Get("/products/:id/reviews")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.reviews.listPublicReviews(
        req.params.id,
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Get("/reviews")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.reviews.listOwnReviews(
        req.auth.user.id,
        req.query,
      );
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(reviewBody)
  @Post("/reviews")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.reviews.createReview(
          req.auth.user.id,
          req.body,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(
    reviewBody
      .omit({ productId: true, orderItemId: true })
      .and(z.object({ version: z.number().int().positive() })),
  )
  @Patch("/reviews/:id")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.reviews.updateReview(
          req.auth.user.id,
          req.params.id,
          req.body,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Delete("/reviews/:id")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.reviews.deleteReview(
        req.auth.user.id,
        req.params.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }
}

@Controller("admin")
export class AdminReviewController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("reviews.moderate")
  @Get("/reviews")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.reviews.listAdminReviews(req.query);
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("reviews.moderate")
  @ValidateRequest(
    z.object({
      status: z.enum(["approved", "rejected", "spam"]),
      reason: z.string().trim().min(3).max(500),
      version: z.number().int().positive(),
    }),
  )
  @Post("/reviews/:id/moderate")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.reviews.moderateReview(
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
  @Permissions("reviews.moderate")
  @ValidateRequest(z.object({ response: z.string().trim().min(1).max(2000) }))
  @Post("/reviews/:id/respond")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.reviews.respondToReview(
          req.params.id,
          req.body.response,
          req.auth.user.id,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
