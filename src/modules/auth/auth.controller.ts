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
  RequestOriginGuard,
  ValidateRequest,
} from "../../app/request-security.js";
const password = z
  .string()
  .min(8)
  .max(128)
  .regex(/[A-Za-z]/, "Include at least one letter.")
  .regex(/\d/, "Include at least one number.");
const identifier = z.string().trim().min(3).max(190);
const code = z.string().trim().min(6).max(40);
const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().optional().default(""),
  email: z.string().optional().default(""),
  password,
  locale: z.enum(["en", "bn"]).default("en"),
  rememberMe: z.boolean().default(true),
  orderReference: z.string().trim().min(6).max(40).optional(),
});
const loginSchema = z.object({
  identifier,
  password: z.string().min(1).max(128),
  rememberMe: z.boolean().default(true),
});
const context = (req: Request) => ({
  userAgent: req.get("user-agent"),
  ip: req.ip,
});
const cookieOptions = (expires: Date) => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAME_SITE,
  path: `${env.API_BASE_PATH}/auth`,
  expires,
});

type TokenResult = {
  mfaRequired?: boolean;
  refreshToken?: string;
  refreshExpiresAt?: Date;
  accessToken?: string;
  accessExpiresIn?: number;
  user?: unknown;
  [key: string]: unknown;
};

function sendTokens(
  req: Request,
  res: Response,
  result: TokenResult,
  status = 200,
) {
  if (result.mfaRequired)
    return res
      .status(status)
      .json({ data: result, meta: null, requestId: req.id });
  res.cookie(
    env.REFRESH_COOKIE_NAME,
    result.refreshToken!,
    cookieOptions(result.refreshExpiresAt!),
  );
  return res.status(status).json({
    data: {
      accessToken: result.accessToken!,
      accessExpiresIn: result.accessExpiresIn!,
      user: result.user,
    },
    meta: null,
    requestId: req.id,
  });
}

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @ValidateRequest(registerSchema)
  @Post("/register")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      sendTokens(
        req,
        res,
        await this.services.auth.register(req.body, context(req)),
        201,
      ))(request, response);
  }

  @ValidateRequest(loginSchema)
  @Post("/login")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      sendTokens(
        req,
        res,
        await this.services.auth.login(req.body, context(req)),
      ))(request, response);
  }

  @ValidateRequest(
    z.object({ challengeToken: z.string().min(32).max(200), code }),
  )
  @Post("/mfa/verify")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      sendTokens(
        req,
        res,
        await this.services.auth.verifyMfaLogin(req.body, context(req)),
      ))(request, response);
  }

  @UseGuards(RequestOriginGuard)
  @Post("/refresh")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      try {
        return sendTokens(
          req,
          res,
          await this.services.auth.refresh(
            req.cookies[env.REFRESH_COOKIE_NAME],
            context(req),
          ),
        );
      } catch (error) {
        res.clearCookie(env.REFRESH_COOKIE_NAME, cookieOptions(new Date(0)));
        throw error;
      }
    })(request, response);
  }

  @UseGuards(RequestOriginGuard)
  @Post("/logout")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.logout(req.cookies[env.REFRESH_COOKIE_NAME]);
      res.clearCookie(env.REFRESH_COOKIE_NAME, cookieOptions(new Date(0)));
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Post("/logout-all")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.logoutAll(req.auth.user.id);
      res.clearCookie(env.REFRESH_COOKIE_NAME, cookieOptions(new Date(0)));
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Get("/me")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: this.services.auth.publicUser(req.auth.user),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Get("/sessions")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.auth.listSessions(
          req.auth.user.id,
          req.auth.session.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Delete("/sessions/:id")
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.revokeSession(req.auth.user.id, req.params.id);
      res.status(204).end();
    })(request, response);
  }

  @ValidateRequest(z.object({ identifier }))
  @Post("/forgot-password")
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.forgotPassword(
        req.body.identifier,
        context(req),
      );
      res
        .status(202)
        .json({ data: { accepted: true }, meta: null, requestId: req.id });
    })(request, response);
  }

  @ValidateRequest(z.object({ token: z.string().min(32).max(200), password }))
  @Post("/reset-password")
  route10(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.resetPassword(req.body);
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(
    z.object({ currentPassword: z.string().min(1).max(128), password }),
  )
  @Post("/change-password")
  route11(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.changePassword(
        req.auth.user.id,
        req.auth.session.id,
        req.body,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(z.object({ channel: z.enum(["phone", "email"]) }))
  @Post("/verify/resend")
  route12(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.resendVerification(
        req.auth.user.id,
        req.body.channel,
      );
      res
        .status(202)
        .json({ data: { accepted: true }, meta: null, requestId: req.id });
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(z.object({ code: z.string().regex(/^\d{6}$/) }))
  @Post(`/verify/${"phone"}`)
  route13(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.verifyIdentity(
        req.auth.user.id,
        "phone",
        req.body.code,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(z.object({ code: z.string().regex(/^\d{6}$/) }))
  @Post(`/verify/${"email"}`)
  route14(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.verifyIdentity(
        req.auth.user.id,
        "email",
        req.body.code,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(z.object({ label: z.string().trim().max(120).optional() }))
  @Post("/mfa/setup")
  route15(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.auth.setupMfa(req.auth.user, req.body.label),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(
    z.object({
      enrollmentId: z.string().length(26),
      code: z.string().regex(/^\d{6}$/),
    }),
  )
  @Post("/mfa/confirm")
  route16(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.auth.confirmMfa(
          req.auth.user.id,
          req.body,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(z.object({ password: z.string().min(1).max(128), code }))
  @Delete("/mfa")
  route17(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<unknown> {
    return (async (req, res) => {
      await this.services.auth.disableMfa(
        req.auth.user,
        req.auth.session.id,
        req.body,
        req,
      );
      res.status(204).end();
    })(request, response);
  }
}
