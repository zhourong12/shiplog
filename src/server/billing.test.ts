import { createHmac } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  StripeBilling,
  encodeForm,
  subscriptionRenewsAt,
  verifyWebhook,
} from "./billing/stripe.js";
import { openDatabase } from "./db/database.js";
import { ShipLogService } from "./services/shiplogService.js";
import { testConfig } from "./testing.js";

const SECRET = "whsec_test_secret";
const BASE = "https://shiplog.example";

beforeAll(() => {
  process.env.SHIPLOG_ENCRYPTION_KEY = "test-encryption-key-0123456789";
});

function sign(payload: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

const renewSeconds = Math.floor(Date.parse("2026-11-14T00:00:00Z") / 1000);

/** A fake Stripe that records form posts. */
function fakeStripe() {
  const calls: Array<{ method: string; path: string; form: URLSearchParams }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const form = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method: init?.method ?? "GET", path: url.pathname, form });
    if (url.pathname === "/v1/customers") return Response.json({ id: "cus_123" });
    if (url.pathname === "/v1/checkout/sessions") {
      return Response.json({ id: "cs_1", url: "https://checkout.stripe.example/cs_1" });
    }
    if (url.pathname === "/v1/billing_portal/sessions") {
      return Response.json({ url: "https://billing.stripe.example/p_1" });
    }
    if (url.pathname === "/v1/subscriptions/sub_1") {
      return Response.json({
        id: "sub_1",
        customer: "cus_123",
        status: "active",
        items: { data: [{ current_period_end: renewSeconds }] },
      });
    }
    return Response.json({ error: { type: "invalid_request_error" } }, { status: 400 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function setup() {
  const config = testConfig({
    authMode: "github",
    publicBaseUrl: BASE,
    github: { clientId: "cid", clientSecret: "s", oauthBaseUrl: "https://github.example" },
    stripe: { secretKey: "sk_test_x", priceId: "price_pro", webhookSecret: SECRET },
  });
  const db = openDatabase(":memory:");
  const service = new ShipLogService({ db, config, llmFactory: () => null });
  const stripe = fakeStripe();
  const billing = new StripeBilling(config.stripe!, db, service.users, BASE, stripe.fetchImpl);
  const app = createApp({ service, config, billing });
  const user = service.users.upsertGithubUser({
    githubId: 7,
    login: "dev",
    name: "Dev",
    avatarUrl: null,
    email: "dev@example.com",
  });
  const session = service.sessions.create(user.id, 3600_000).token;
  return { app, service, stripe, user, cookie: `shiplog_session=${session}` };
}

function webhook(app: ReturnType<typeof setup>["app"], event: object, signature?: string) {
  const payload = JSON.stringify(event);
  return request(app)
    .post("/api/billing/webhook")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signature ?? sign(payload))
    .send(payload);
}

describe("Stripe webhook signatures", () => {
  const payload = Buffer.from(JSON.stringify({ id: "evt_1", type: "x", data: { object: {} } }));

  it("accepts a valid signature and rejects tampering, wrong secrets and stale requests", () => {
    expect(verifyWebhook(payload, sign(payload.toString()), SECRET).id).toBe("evt_1");
    expect(() => verifyWebhook(Buffer.from("{}"), sign(payload.toString()), SECRET)).toThrow(
      "签名无效",
    );
    expect(() => verifyWebhook(payload, sign(payload.toString(), "whsec_other"), SECRET)).toThrow(
      "签名无效",
    );
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(() => verifyWebhook(payload, sign(payload.toString(), SECRET, old), SECRET)).toThrow(
      "已过期",
    );
    expect(() => verifyWebhook(payload, undefined, SECRET)).toThrow("缺少");
  });

  it("encodes bracketed form fields and reads renewal dates from either location", () => {
    expect(encodeForm({ "line_items[0][price]": "p", skip: undefined, n: 1 })).toBe(
      "line_items%5B0%5D%5Bprice%5D=p&n=1",
    );
    expect(subscriptionRenewsAt({ items: { data: [{ current_period_end: renewSeconds }] } })).toBe(
      "2026-11-14T00:00:00.000Z",
    );
    expect(subscriptionRenewsAt({ current_period_end: renewSeconds })).toBe(
      "2026-11-14T00:00:00.000Z",
    );
    expect(subscriptionRenewsAt({})).toBeNull();
  });
});

describe("billing flow", () => {
  it("creates the customer once and a subscription checkout for the signed-in user", async () => {
    const { app, stripe, cookie, service, user } = setup();
    const first = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", cookie)
      .expect(200);
    expect(first.body.data.url).toBe("https://checkout.stripe.example/cs_1");
    await request(app).post("/api/billing/checkout").set("Cookie", cookie).expect(200);

    expect(stripe.calls.filter((call) => call.path === "/v1/customers")).toHaveLength(1);
    const checkout = stripe.calls.find((call) => call.path === "/v1/checkout/sessions")!;
    expect(Object.fromEntries(checkout.form)).toMatchObject({
      mode: "subscription",
      customer: "cus_123",
      client_reference_id: String(user.id),
      "line_items[0][price]": "price_pro",
      success_url: `${BASE}/?billing=success#settings`,
    });
    expect(service.users.get(user.id)?.stripeCustomerId).toBe("cus_123");
  });

  it("requires sign-in for checkout and portal", async () => {
    const { app } = setup();
    await request(app).post("/api/billing/checkout").expect(401);
    await request(app).post("/api/billing/portal").expect(401);
  });

  it("turns Pro on from a completed checkout and off when the subscription ends", async () => {
    const { app, cookie, service, user } = setup();
    await request(app).post("/api/billing/checkout").set("Cookie", cookie).expect(200);

    const completed = {
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: { object: { customer: "cus_123", subscription: "sub_1" } },
    };
    await webhook(app, completed).expect(200);
    expect(service.users.get(user.id)).toMatchObject({
      plan: "pro",
      planStatus: "active",
      planRenewsAt: "2026-11-14T00:00:00.000Z",
    });
    const me = await request(app).get("/api/me").set("Cookie", cookie).expect(200);
    expect(me.body.data).toMatchObject({
      plan: "pro",
      billing: { enabled: true, canManage: true },
    });
    const usage = await request(app).get("/api/usage").set("Cookie", cookie).expect(200);
    expect(usage.body.data.limits.aiRunsPerMonth).toBeNull();

    const again = await webhook(app, completed).expect(200);
    expect(again.body.duplicate).toBe(true);

    await request(app).post("/api/billing/checkout").set("Cookie", cookie).expect(409);
    const portal = await request(app).post("/api/billing/portal").set("Cookie", cookie).expect(200);
    expect(portal.body.data.url).toBe("https://billing.stripe.example/p_1");

    await webhook(app, {
      id: "evt_deleted",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_123", status: "canceled" } },
    }).expect(200);
    expect(service.users.get(user.id)).toMatchObject({ plan: "free", planStatus: "canceled" });
  });

  it("rejects unsigned webhooks without changing anything", async () => {
    const { app, service, user } = setup();
    service.users.setStripeCustomer(user.id, "cus_123");
    const event = {
      id: "evt_forged",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: "cus_123", status: "active" } },
    };
    const response = await webhook(app, event, sign(JSON.stringify(event), "whsec_attacker"));
    expect(response.status).toBe(400);
    expect(service.users.get(user.id)?.plan).toBe("free");
  });

  it("is off in local mode", async () => {
    const config = testConfig();
    const service = new ShipLogService({
      db: openDatabase(":memory:"),
      config,
      llmFactory: () => null,
    });
    const app = createApp({ service, config });
    const response = await request(app).post("/api/billing/checkout").expect(404);
    expect(response.body.error.code).toBe("billing_disabled");
  });
});
