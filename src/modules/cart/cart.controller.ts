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
  CartContextGuard,
  OptionalAccessTokenGuard,
  ValidateRequest,
} from "../../app/request-security.js";
const locale = (req: Request): "en" | "bn" =>
  req.query.locale === "bn" ? "bn" : "en";
const cartCookie = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAME_SITE,
  path: "/",
  signed: true,
  maxAge: 30 * 86400000,
};

@Controller("carts")
export class CartController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard)
  @Post("/merge")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const guestToken = req.signedCookies[this.services.carts.CART_COOKIE];
      const { cart } = await this.services.carts.resolveCart(
        null,
        req.auth.user.id,
        true,
      );
      const merge = await this.services.carts.mergeGuestCart(
        cart!.id,
        guestToken,
      );
      res.clearCookie(this.services.carts.CART_COOKIE, {
        ...cartCookie,
        maxAge: undefined,
      });
      res.json({
        data: {
          cart: await this.services.carts.getCart(
            cart!.id,
            locale(req),
            req.auth.user.id,
          ),
          changes: merge.changes,
        },
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @Post("/")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.carts.getCart(
          req.cart.id,
          locale(req),
          req.auth?.user.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @Get("/current")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.carts.getCart(
          req.cart.id,
          locale(req),
          req.auth?.user.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @ValidateRequest(
    z.object({
      variantId: z.string().length(26),
      quantity: z.number().int().min(1).max(99),
    }),
  )
  @Post("/items")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.carts.addItem(req.cart.id, req.body);
      res.status(201).json({
        data: await this.services.carts.getCart(
          req.cart.id,
          locale(req),
          req.auth?.user.id,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @ValidateRequest(
    z.object({
      quantity: z.number().int().min(0).max(99),
      version: z.number().int().positive().optional(),
    }),
  )
  @Patch("/items/:id")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.carts.updateItem(
        req.cart.id,
        req.params.id,
        req.body.quantity,
        req.body.version,
      );
      res.json({
        data: await this.services.carts.getCart(
          req.cart.id,
          locale(req),
          req.auth?.user.id,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @Delete("/items/:id")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.carts.removeItem(req.cart.id, req.params.id);
      res.json({
        data: await this.services.carts.getCart(
          req.cart.id,
          locale(req),
          req.auth?.user.id,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @ValidateRequest(z.object({ code: z.string().trim().min(1).max(80) }))
  @Post("/coupons")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.carts.applyCoupon(
        req.cart.id,
        req.body.code,
        req.auth?.user.id,
      );
      res.json({
        data: await this.services.carts.getCart(
          req.cart.id,
          locale(req),
          req.auth?.user.id,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }

  @UseGuards(CartContextGuard)
  @UseGuards(OptionalAccessTokenGuard)
  @Delete("/coupons/:code")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.carts.removeCoupon(req.cart.id, req.params.code);
      res.json({
        data: await this.services.carts.getCart(
          req.cart.id,
          locale(req),
          req.auth?.user.id,
        ),
        meta: null,
        requestId: req.id,
      });
    })(request, response);
  }
}
