import { createHmac, timingSafeEqual } from "node:crypto";
import type { Plan } from "../../shared/schemas.js";
import type { StripeConfig } from "../config.js";
import type { Db } from "../db/database.js";
import type { UserRecord, UserStore } from "../db/stores.js";
import { HttpError } from "../services/errors.js";

const STRIPE_API = "https://api.stripe.com";
/** Webhooks older than this are rejected, which limits replay of a captured request. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Stripe statuses that keep Pro on. past_due keeps it during Stripe's retry window. */
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

type FormValue = string | number | boolean | undefined;

/** Stripe's REST API takes bracketed form fields: line_items[0][price]=… */
export function encodeForm(fields: Record<string, FormValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.append(key, String(value));
  }
  return params.toString();
}

/**
 * Verify the Stripe-Signature header: t=<unix>,v1=<hex HMAC-SHA256 of "t.payload">.
 * Throws on a bad or stale signature; returns the parsed event otherwise.
 */
export function verifyWebhook(
  payload: Buffer,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): StripeEvent {
  if (!header) throw new HttpError(400, "bad_signature", "缺少 Stripe 签名。");
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new HttpError(400, "bad_signature", "Stripe 签名格式不正确。");
  }
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new HttpError(400, "bad_signature", "Stripe 签名已过期。");
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${payload.toString("utf8")}`)
    .digest();
  const valid = signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new HttpError(400, "bad_signature", "Stripe 签名无效。");
  try {
    return JSON.parse(payload.toString("utf8")) as StripeEvent;
  } catch {
    throw new HttpError(400, "bad_payload", "Stripe 事件不是合法的 JSON。");
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * The renewal time moved from the subscription to its items in newer API versions;
 * read whichever is present.
 */
export function subscriptionRenewsAt(subscription: Record<string, unknown>): string | null {
  const items = (subscription.items as { data?: Array<Record<string, unknown>> } | undefined)?.data;
  const seconds = items?.[0]?.current_period_end ?? subscription.current_period_end;
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;
}

export class StripeBilling {
  constructor(
    private readonly config: StripeConfig,
    private readonly db: Db,
    private readonly users: UserStore,
    private readonly publicBaseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(
    method: "GET" | "POST",
    path: string,
    fields?: Record<string, FormValue>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${STRIPE_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: fields ? encodeForm(fields) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HttpError(502, "billing_unavailable", "无法连接支付服务，请稍后重试。");
    }
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) {
      // Stripe error messages can echo request data; log only the type.
      const type = (json?.error as { type?: string } | undefined)?.type ?? response.status;
      console.error("[shiplog] Stripe request failed:", path, type);
      throw new HttpError(502, "billing_failed", "支付服务暂时不可用，请稍后重试。");
    }
    return json;
  }

  private async ensureCustomer(user: UserRecord): Promise<string> {
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const customer = await this.request("POST", "/v1/customers", {
      email: user.email ?? undefined,
      name: user.name ?? user.login,
      "metadata[user_id]": user.id,
      "metadata[github_login]": user.login,
    });
    const id = asString(customer.id);
    if (!id) throw new HttpError(502, "billing_failed", "创建付款账户失败。");
    this.users.setStripeCustomer(user.id, id);
    return id;
  }

  async createCheckout(user: UserRecord): Promise<string> {
    if (user.plan === "pro") throw new HttpError(409, "already_pro", "你已经是 Pro 了。");
    const customer = await this.ensureCustomer(user);
    const session = await this.request("POST", "/v1/checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      "line_items[0][price]": this.config.priceId,
      "line_items[0][quantity]": 1,
      "subscription_data[metadata][user_id]": user.id,
      allow_promotion_codes: true,
      success_url: `${this.publicBaseUrl}/?billing=success#settings`,
      cancel_url: `${this.publicBaseUrl}/?billing=cancel#settings`,
    });
    const url = asString(session.url);
    if (!url) throw new HttpError(502, "billing_failed", "创建付款页面失败。");
    return url;
  }

  async createPortal(user: UserRecord): Promise<string> {
    if (!user.stripeCustomerId) {
      throw new HttpError(400, "no_subscription", "还没有订阅记录。");
    }
    const session = await this.request("POST", "/v1/billing_portal/sessions", {
      customer: user.stripeCustomerId,
      return_url: `${this.publicBaseUrl}/#settings`,
    });
    const url = asString(session.url);
    if (!url) throw new HttpError(502, "billing_failed", "打开订阅管理失败。");
    return url;
  }

  /** Apply a subscription's state to the user who owns its customer. */
  private applySubscription(subscription: Record<string, unknown>): void {
    const customer = asString(subscription.customer);
    if (!customer) return;
    const user = this.users.byStripeCustomer(customer);
    if (!user) return;
    const status = asString(subscription.status) ?? "unknown";
    const plan: Plan = ACTIVE_STATUSES.has(status) ? "pro" : "free";
    this.users.setPlan(user.id, {
      plan,
      subscriptionId: asString(subscription.id),
      status,
      renewsAt: plan === "pro" ? subscriptionRenewsAt(subscription) : null,
    });
  }

  /** Returns false when the event was already processed (Stripe retries deliveries). */
  async handleEvent(event: StripeEvent): Promise<boolean> {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)")
      .run(event.id, event.type, new Date().toISOString());
    if (inserted.changes === 0) return false;
    try {
      await this.process(event);
    } catch (error) {
      // Forget the event so Stripe's retry is processed instead of skipped as a duplicate.
      this.db.prepare("DELETE FROM stripe_events WHERE id = ?").run(event.id);
      throw error;
    }
    return true;
  }

  private async process(event: StripeEvent): Promise<void> {
    const object = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        const subscriptionId = asString(object.subscription);
        if (subscriptionId) {
          // Fetch the subscription so plan state never depends on event ordering.
          this.applySubscription(await this.request("GET", `/v1/subscriptions/${subscriptionId}`));
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        this.applySubscription(object);
        break;
      default:
        break;
    }
  }
}
