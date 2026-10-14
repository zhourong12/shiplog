import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { AnthropicLlm } from "./ai/llm.js";
import { createApp } from "./app.js";
import { StripeBilling } from "./billing/stripe.js";
import { smtpMailer } from "./scheduler/notify.js";
import { ScheduleService, SchedulerLoop } from "./scheduler/scheduler.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { ShipLogService } from "./services/shiplogService.js";

async function clientMiddleware(isProduction: boolean): Promise<express.RequestHandler[]> {
  if (isProduction) {
    const dist = resolve(process.cwd(), "dist");
    if (!existsSync(dist)) return [];
    return [
      express.static(dist, { index: false, maxAge: "1h" }),
      (_req, res) => res.sendFile(resolve(dist, "index.html")),
    ];
  }
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  return [vite.middlewares];
}

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const service = new ShipLogService({
    db,
    config,
    llmFactory: () => (config.aiConfigured ? new AnthropicLlm({ model: config.model }) : null),
  });
  // Billing needs accounts: it is only enabled with GitHub sign-in.
  const billing =
    config.stripe && config.authMode === "github"
      ? new StripeBilling(config.stripe, db, service.users, config.publicBaseUrl)
      : null;
  const schedules = new ScheduleService({
    service,
    mailer: config.smtp ? smtpMailer(config.smtp) : null,
  });
  if (config.schedulerEnabled) new SchedulerLoop(schedules).start();
  const app = createApp({
    service,
    config,
    billing,
    schedules,
    clientMiddleware: await clientMiddleware(config.isProduction),
  });
  app.listen(config.port, config.host, () => {
    console.log(`ShipLog 已启动：http://${config.host}:${config.port}`);
    console.log(
      config.aiConfigured
        ? `AI：已启用（${config.model}）`
        : "AI：未配置 ANTHROPIC_API_KEY，只生成更新日志和数据卡",
    );
  });
}

main().catch((error: unknown) => {
  console.error("ShipLog 启动失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
