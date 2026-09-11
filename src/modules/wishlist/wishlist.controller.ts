import {
  Controller,
  Delete,
  Get,
  Inject,
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
  OptionalAccessTokenGuard,
  ValidateRequest,
  WishlistContextGuard,
} from "../../app/request-security.js";
const locale = (req: Request): "en" | "bn" =>
  req.query.locale === "bn" ? "bn" : "en";

@Controller("wishlist")
export class WishlistController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard)
  @Post("/merge")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const token = req.signedCookies[this.services.wishlists.WISHLIST_COOKIE];
      const { wishlist } = await this.services.wishlists.resolveWishlist(
        null,
        req.auth.user.id,
        true,
      );
      await this.services.wishlists.mergeGuestWishlist(wishlist!.id, token);
      res.clearCookie(this.services.wishlists.WISHLIST_COOKIE, {
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: env.COOKIE_SAME_SITE,
        path: "/",
        signed: true,
      });
      res.json({
        data: await this.services.wishlists.getWishlist(
          wishlist!.id,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(WishlistContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @Get("/")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.wishlists.getWishlist(
          req.wishlist.id,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(WishlistContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @ValidateRequest(
    z.object({
      productId: z.string().length(26),
      variantId: z.string().length(26).nullable().optional(),
    }),
  )
  @Post("/items")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.wishlists.addWishlistItem(req.wishlist.id, req.body);
      res.status(201).json({
        data: await this.services.wishlists.getWishlist(
          req.wishlist.id,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(WishlistContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @Delete("/items/:id")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.wishlists.removeWishlistItem(
        req.wishlist.id,
        String(req.params.id),
      );
      res.json({
        data: await this.services.wishlists.getWishlist(
          req.wishlist.id,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }
}
