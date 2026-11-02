import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UseInterceptors,
} from "@nestjs/common";
import type { CallHandler, NestInterceptor } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { RedisStore } from "rate-limit-redis";
import { Observable } from "rxjs";
import type { ZodType } from "zod";
import {
  authenticateRequest,
  requireRequestPermission,
} from "./middleware/authenticate.js";
import { assertRequestOrigin } from "./middleware/origin-guard.js";
import { type RequestSource, validateRequest } from "./middleware/validate.js";
import { env } from "../config/env.js";
import { redis } from "../lib/redis.js";
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

// Shared Redis counters keep limits consistent across API instances.
const limiterStore = (prefix: string) =>
  env.REDIS_OPTIONAL
    ? undefined
    : new RedisStore({
        prefix: `rate:${prefix}:`,
        sendCommand: async (command: string, ...args: string[]) =>
          (await redis.call(command, ...args)) as never,
      });

// Built on first use: RedisStore loads its scripts on construction, which must
// not happen at import time before the Redis connection is established.
const hourlyLimiter = (prefix: string, limit: number) => {
  let instance: ReturnType<typeof rateLimit> | undefined;
  return () =>
    (instance ??= rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: env.NODE_ENV === "test" ? 1000 : limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      store: limiterStore(prefix),
    }));
};

const guestReturnLimiter = hourlyLimiter("guest-return", 20);
const contactLimiter = hourlyLimiter("contact", 10);
const manualPaymentLimiter = hourlyLimiter("manual-payment", 15);
const trackingLimiter = hourlyLimiter("tracking", 1200);

@Injectable()
export class ContactRateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    return new Promise((resolve, reject) => {
      contactLimiter()(
        http.getRequest(),
        http.getResponse(),
        (error?: unknown) => (error ? reject(error) : resolve(true)),
      );
    });
  }
}

@Injectable()
export class TrackingRateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    return new Promise((resolve, reject) => {
      trackingLimiter()(
        http.getRequest(),
        http.getResponse(),
        (error?: unknown) => (error ? reject(error) : resolve(true)),
      );
    });
  }
}

@Injectable()
export class ManualPaymentRateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    return new Promise((resolve, reject) => {
      manualPaymentLimiter()(
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
      guestReturnLimiter()(
        http.getRequest(),
        http.getResponse(),
        (error?: unknown) => (error ? reject(error) : resolve(true)),
      );
    });
  }
}

const permissionMetadata = Symbol("required-permissions");
// Stacked @Permissions decorators accumulate; every listed key is required.
export const Permissions =
  (...permissions: string[]): MethodDecorator =>
  (_target, _key, descriptor) => {
    const existing =
      (Reflect.getMetadata(permissionMetadata, descriptor.value as object) as
        string[] | undefined) ?? [];
    Reflect.defineMetadata(
      permissionMetadata,
      [...existing, ...permissions],
      descriptor.value as object,
    );
    return descriptor;
  };

@Injectable()
export class PermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const permissions = (Reflect.getMetadata(
      permissionMetadata,
      context.getHandler(),
    ) ?? []) as string[];
    const request = context.switchToHttp().getRequest<Request>();
    for (const permission of permissions)
      requireRequestPermission(request, permission);
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
