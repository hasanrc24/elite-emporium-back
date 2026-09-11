import { Controller, Get, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { liveHealth, readyHealth, versionInfo } from "./health.js";
import { metricsHandler } from "../lib/metrics.js";

export const openapiDocument = YAML.parse(
  readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"),
  { maxAliasCount: 1_000 },
);

@Controller()
export class CoreController {
  @Get("health/live") live(@Req() req: Request, @Res() res: Response) {
    return liveHealth(req, res);
  }
  @Get("health/ready") ready(@Req() req: Request, @Res() res: Response) {
    return readyHealth(req, res);
  }
  @Get("version") version(@Req() req: Request, @Res() res: Response) {
    return versionInfo(req, res);
  }
  @Get("metrics") metrics(@Req() req: Request, @Res() res: Response) {
    return metricsHandler(req, res);
  }
  @Get("openapi.json") openapi(@Res() res: Response) {
    return res.json(openapiDocument);
  }
}
