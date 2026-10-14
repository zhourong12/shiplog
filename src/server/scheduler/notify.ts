import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import nodemailer from "nodemailer";
import type { GenerationResult, WebhookKind } from "../../shared/schemas.js";
import { platformSpecs } from "../../shared/platformRules.js";
import type { SmtpConfig } from "../config.js";
import { HttpError } from "../services/errors.js";

export interface Digest {
  subject: string;
  text: string;
  url: string;
  generationId: string | null;
}

/** A short, plain-text summary that reads well in email, chat apps and push previews. */
export function buildDigest(result: GenerationResult, publicBaseUrl: string): Digest {
  const url = `${publicBaseUrl}/#history/${result.id}`;
  const ready = result.drafts.filter((draft) => draft.status === "ok").length;
  const lines = [
    `ShipLog · ${result.repoLabel}`,
    result.dayHeadline ?? "今天的更新日志已生成",
    `${result.totals.commits} 次提交 · +${result.totals.additions} / -${result.totals.deletions} 行`,
  ];
  if (result.drafts.length > 0) {
    lines.push(
      `草稿 ${ready}/${result.drafts.length} 份通过检查：${result.drafts
        .map(
          (draft) => `${platformSpecs[draft.platform].label}${draft.status === "ok" ? "✓" : "⚠"}`,
        )
        .join("、")}`,
    );
    const first = result.drafts[0];
    if (first) {
      const preview = first.body.length > 160 ? `${first.body.slice(0, 160)}…` : first.body;
      lines.push("", `${platformSpecs[first.platform].label}草稿预览：`, preview);
    }
  } else if (result.baselineReason) {
    lines.push(result.baselineReason);
  }
  if (result.milestones.length > 0) {
    lines.push(`🎉 ${result.milestones.map((milestone) => milestone.label).join("、")}`);
  }
  lines.push("", `打开查看和发布：${url}`);
  return {
    subject: `ShipLog：${result.dayHeadline ?? `${result.repoLabel} 开发日记`}`,
    text: lines.join("\n"),
    url,
    generationId: result.id,
  };
}

/** Request bodies for the chat tools people paste incoming-webhook URLs from. */
export function webhookPayload(kind: WebhookKind, digest: Digest): unknown {
  switch (kind) {
    case "slack":
      return { text: digest.text };
    case "discord":
      return { content: digest.text.slice(0, 1900) };
    case "feishu":
      return { msg_type: "text", content: { text: digest.text } };
    case "generic":
      return {
        title: digest.subject,
        text: digest.text,
        url: digest.url,
        generationId: digest.generationId,
      };
  }
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff")
    );
  }
  return true;
}

export type Lookup = (hostname: string) => Promise<string[]>;

const defaultLookup: Lookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

/**
 * Webhook URLs come from users, so the server must not be steered into calling its own
 * network (SSRF): HTTPS only, no credentials, and every resolved address must be public.
 */
export async function assertPublicWebhookUrl(
  raw: string,
  resolve: Lookup = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "invalid_webhook", "Webhook 地址格式不正确。");
  }
  if (url.protocol !== "https:") {
    throw new HttpError(400, "invalid_webhook", "Webhook 地址必须以 https:// 开头。");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "invalid_webhook", "Webhook 地址不能包含用户名或密码。");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal")
  ) {
    throw new HttpError(400, "invalid_webhook", "Webhook 地址不能指向内网。");
  }
  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  } catch {
    throw new HttpError(400, "invalid_webhook", "无法解析 Webhook 域名。");
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new HttpError(400, "invalid_webhook", "Webhook 地址不能指向内网。");
  }
  return url;
}

export async function sendWebhook(
  rawUrl: string,
  kind: WebhookKind,
  digest: Digest,
  options: { fetchImpl?: typeof fetch; resolve?: Lookup } = {},
): Promise<void> {
  const url = await assertPublicWebhookUrl(rawUrl, options.resolve);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "shiplog" },
      body: JSON.stringify(webhookPayload(kind, digest)),
      // A redirect could point anywhere, including the internal network.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, "webhook_failed", "Webhook 请求失败，请检查地址是否可访问。");
  }
  if (!response.ok) {
    throw new HttpError(502, "webhook_failed", `Webhook 返回了状态 ${response.status}。`);
  }
}

export interface Mailer {
  send(to: string, digest: Digest): Promise<void>;
}

export function smtpMailer(config: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport(config.url);
  return {
    async send(to, digest) {
      try {
        await transport.sendMail({
          from: config.from,
          to,
          subject: digest.subject,
          text: digest.text,
        });
      } catch {
        throw new HttpError(502, "email_failed", "邮件发送失败，请检查 SMTP 配置。");
      }
    },
  };
}

export const emailPattern = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;
