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
  ValidateRequest,
} from "../../app/request-security.js";
import { publicUser } from "../auth/auth.service.js";

const addressFields = {
  label: z.string().trim().min(1).max(80),
  recipientName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(11).max(30),
  addressLine: z.string().trim().min(5).max(500),
  area: z.string().trim().max(120).nullable().optional(),
  district: z.string().trim().max(120).nullable().optional(),
  division: z.string().trim().max(120).nullable().optional(),
  postcode: z.string().trim().max(20).nullable().optional(),
  landmark: z.string().trim().max(255).nullable().optional(),
  isDefaultShipping: z.boolean().optional().default(false),
  isDefaultBilling: z.boolean().optional().default(false),
};
const createAddressSchema = z.object(addressFields);
const updateAddressSchema = z.object({
  ...addressFields,
  version: z.number().int().positive(),
});

@Controller("users")
export class UserController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @UseGuards(AccessTokenGuard)
  @Get("/me")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: publicUser(req.auth.user),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(
    z.object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      email: z.string().trim().email().max(190).nullable().optional(),
      locale: z.enum(["en", "bn"]).optional(),
      currentPassword: z.string().max(128).optional(),
      version: z.number().int().positive(),
    }),
  )
  @Patch("/me")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.users.updateProfile(
          req.auth.user.id,
          req.auth.session.id,
          req.body,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Get("/me/addresses")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.users.listAddresses(req.auth.user.id),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(createAddressSchema)
  @Post("/me/addresses")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.users.createAddress(
          req.auth.user.id,
          req.body,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(updateAddressSchema)
  @Patch("/me/addresses/:id")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.users.updateAddress(
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
  @Delete("/me/addresses/:id")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      await this.services.users.deleteAddress(
        req.auth.user.id,
        req.params.id,
        req,
      );
      res.status(204).end();
    })(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @Get("/me/privacy-requests")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.privacy.listOwnPrivacyRequests(
          req.auth.user.id,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @UseGuards(AccessTokenGuard)
  @ValidateRequest(
    z.object({
      type: z.enum(["export", "deletion"]),
      note: z.string().trim().max(500).optional(),
      currentPassword: z.string().max(128).optional(),
      confirmation: z.string().max(80).optional(),
    }),
  )
  @Post("/me/privacy-requests")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.status(201).json({
        data: await this.services.privacy.createPrivacyRequest(
          req.auth.user.id,
          req.body,
          req,
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
