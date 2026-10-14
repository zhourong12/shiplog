import express from "express";
import type { StripeBilling } from "../billing/stripe.js";
import { verifyWebhook } from "../billing/stripe.js";
import { currentUser } from "../http.js";
import { HttpError } from "../services/errors.js";
import type { ShipLogService } from "../services/shiplogService.js";

/** The webhook needs the raw body for signature checks, so it is mounted before express.json. */
export function billingWebhookRoutes(
  service: ShipLogService,
  billing: StripeBilling | null,
): express.Router {
  const router = express.Router();
  router.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      if (!billing || !service.config.stripe) {
        throw new HttpError(404, "billing_disabled", "未开启付款。");
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      const event = verifyWebhook(
        body,
        req.get("stripe-signature"),
        service.config.stripe.webhookSecret,
      );
      const processed = await billing.handleEvent(event);
      res.json({ received: true, duplicate: !processed });
    },
  );
  return router;
}

export function billingRoutes(
  service: ShipLogService,
  billing: StripeBilling | null,
): express.Router {
  const router = express.Router();
  const requireBilling = () => {
    if (!billing) throw new HttpError(404, "billing_disabled", "当前部署未开启在线付款。");
    return billing;
  };
  const record = (res: express.Response) => {
    const user = service.users.get(currentUser(res).id);
    if (!user) throw new HttpError(401, "login_required", "请先登录。");
    return user;
  };

  router.post("/api/billing/checkout", async (_req, res) => {
    res.json({ data: { url: await requireBilling().createCheckout(record(res)) } });
  });

  router.post("/api/billing/portal", async (_req, res) => {
    res.json({ data: { url: await requireBilling().createPortal(record(res)) } });
  });

  return router;
}
