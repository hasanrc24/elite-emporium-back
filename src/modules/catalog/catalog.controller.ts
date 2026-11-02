import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApplicationServices } from "../../app/application-services.js";
import {} from "../../app/request-security.js";

const locale = (req: Request): "en" | "bn" =>
  req.query.locale === "bn" ? "bn" : "en";

@Controller("")
export class CatalogController {
  constructor(
    @Inject(ApplicationServices) private readonly services: ApplicationServices,
  ) {}

  @Get("/products")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.catalog.listProducts({
        ...req.query,
        locale: locale(req),
      });
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @Get("/products/:slug")
  route1(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.catalog.getProduct(
          req.params.slug,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/categories")
  route2(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.catalog.listCategories(locale(req)),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/categories/:slug")
  route3(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.catalog.getCategory(
          req.params.slug,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/collections")
  route4(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.catalog.listCollections(locale(req)),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/collections/:slug")
  route5(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.catalog.getCollection(
          req.params.slug,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/brands")
  route6(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.catalog.listBrands(locale(req)),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/attributes")
  route7(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.catalog.listAttributes(locale(req)),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }

  @Get("/search")
  route8(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const result = await this.services.catalog.listProducts({
        ...req.query,
        search: req.query.q,
        locale: locale(req),
      });
      res.json({ ...result, requestId: req.id });
    })(request, response);
  }

  @Get("/search/suggestions")
  route9(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) =>
      res.json({
        data: await this.services.catalog.searchSuggestions(
          req.query.q,
          locale(req),
        ),
        meta: null,
        requestId: req.id,
      }))(request, response);
  }
}
