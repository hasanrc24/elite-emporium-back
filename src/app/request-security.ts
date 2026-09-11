import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseInterceptors,
} from "@nestjs/common";
import type { CallHandler, NestInterceptor } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { Observable } from "rxjs";
import type { ZodType } from "zod";
import {
  authenticateRequest,
  requireRequestPermission,
} from "./middleware/authenticate.js";
import { assertRequestOrigin } from "./middleware/origin-guard.js";
import { type RequestSource, validateRequest } from "./middleware/validate.js";
import { env } from "../config/env.js";
import * as carts from "../modules/cart/cart.service.js";
import * as wishlists from "../modules/wishlist/wishlist.service.js";

@Injectable()
export class AccessTokenGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    await authenticateRequest(context.switchToHttp().getRequest<Request>());
    return true;
  }
}

@Injectable()
export class OptionalAccessTokenGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if ((request.get("authorization") || "").startsWith("Bearer "))
      await authenticateRequest(request);
    return true;
  }
}

@Injectable()
export class RequestOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    assertRequestOrigin(context.switchToHttp().getRequest<Request>());
    return true;
  }
}

@Injectable()
export class CartContextGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse();
    const token = request.signedCookies[carts.CART_COOKIE];
    const { cart, issuedToken } = await carts.resolveCart(
      token,
      request.auth?.user.id,
      true,
    );
    if (issuedToken && !request.auth)
      response.cookie(carts.CART_COOKIE, issuedToken, {
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: env.COOKIE_SAME_SITE,
        path: "/",
        signed: true,
        maxAge: 30 * 86400000,
      });
    request.cart = cart!;
    return true;
  }
}

@Injectable()
export class WishlistContextGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse();
    const token = request.signedCookies[wishlists.WISHLIST_COOKIE];
    const { wishlist, issuedToken } = await wishlists.resolveWishlist(
      token,
      request.auth?.user.id,
      true,
    );
    if (issuedToken && !request.auth)
      response.cookie(wishlists.WISHLIST_COOKIE, issuedToken, {
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: env.COOKIE_SAME_SITE,
        path: "/",
        signed: true,
        maxAge: 90 * 86400000,
      });
    request.wishlist = wishlist!;
    return true;
  }
}

const guestReturnLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

@Injectable()
export class ContactRateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    return new Promise((resolve, reject) => {
      contactLimiter(
        http.getRequest(),
        http.getResponse(),
        (error?: unknown) => (error ? reject(error) : resolve(true)),
      );
    });
  }
}

@Injectable()
export class GuestReturnRateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    return new Promise((resolve, reject) => {
      guestReturnLimiter(
        http.getRequest(),
        http.getResponse(),
        (error?: unknown) => (error ? reject(error) : resolve(true)),
      );
    });
  }
}

const permissionMetadata = Symbol("required-permission");
export const Permissions = (permission: string) =>
  SetMetadata(permissionMetadata, permission);

@Injectable()
export class PermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const permission = Reflect.getMetadata(
      permissionMetadata,
      context.getHandler(),
    ) as string | undefined;
    if (permission)
      requireRequestPermission(
        context.switchToHttp().getRequest<Request>(),
        permission,
      );
    return true;
  }
}

class ZodValidationInterceptor implements NestInterceptor {
  constructor(
    private readonly schema: ZodType,
    private readonly source: RequestSource,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    validateRequest(
      context.switchToHttp().getRequest<Request>(),
      this.schema,
      this.source,
    );
    return next.handle();
  }
}

export const ValidateRequest = (
  schema: ZodType,
  source: RequestSource = "body",
) => UseInterceptors(new ZodValidationInterceptor(schema, source));

export const UploadSingleFile = () =>
  UseInterceptors(
    FileInterceptor("file", {
      storage: multer.memoryStorage(),
      limits: {
        fileSize: Math.max(
          env.MEDIA_MAX_IMAGE_BYTES,
          env.MEDIA_MAX_DOCUMENT_BYTES,
        ),
        files: 1,
        fields: 10,
      },
    }),
  );
