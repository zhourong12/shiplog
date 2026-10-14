import type { PlatformId, ScheduleReport, ScheduleRun, WebhookKind } from "../../shared/schemas.js";
import { HttpError } from "../services/errors.js";
import { toHttpError, type CurrentUser, type ShipLogService } from "../services/shiplogService.js";
import {
  assertPublicWebhookUrl,
  buildDigest,
  emailPattern,
  sendWebhook,
  type Digest,
  type Lookup,
  type Mailer,
} from "./notify.js";
import { ScheduleStore, type StoredSchedule } from "./store.js";
import { isDue, isValidTime, isValidTimeZone, nextRunAt, zonedParts } from "./time.js";

const WEBHOOK_CREDENTIAL = "notify_webhook";

export interface ScheduleInput {
  enabled: boolean;
  repoId: number | null;
  time: string;
  timezone: string;
  platforms: PlatformId[];
  windowHours: number;
  skipEmpty: boolean;
  notifyEmail: string | null;
  webhookKind: WebhookKind | null;
  /** undefined keeps the saved URL, "" removes it, anything else replaces it. */
  webhookUrl?: string;
}

export interface SchedulerDeps {
  service: ShipLogService;
  mailer: Mailer | null;
  fetchImpl?: typeof fetch;
  resolve?: Lookup;
}

/** Daily drafts on a per-user schedule, with email and webhook reminders. */
export class ScheduleService {
  readonly store: ScheduleStore;

  constructor(private readonly deps: SchedulerDeps) {
    this.store = new ScheduleStore(deps.service.deps.db);
  }

  private get service() {
    return this.deps.service;
  }

  private webhookUrl(user: CurrentUser): string | null {
    try {
      return this.service.credentials.get(user.id, WEBHOOK_CREDENTIAL);
    } catch {
      return null;
    }
  }

  report(user: CurrentUser): ScheduleReport {
    const stored = this.store.get(user.id);
    const allowed = this.service.limits(user).scheduling;
    return {
      settings: {
        enabled: stored.enabled,
        repoId: stored.repoId,
        time: stored.time,
        timezone: stored.timezone,
        platforms: stored.platforms,
        windowHours: stored.windowHours,
        skipEmpty: stored.skipEmpty,
        notifyEmail: stored.notifyEmail,
        webhookKind: stored.webhookKind,
        webhookConfigured: this.webhookUrl(user) !== null,
      },
      runs: this.store.runs(user.id),
      nextRunAt:
        allowed && stored.enabled && stored.repoId !== null
          ? nextRunAt(stored, this.service.now()).toISOString()
          : null,
      emailEnabled: this.deps.mailer !== null,
      allowed,
    };
  }

  async save(user: CurrentUser, input: ScheduleInput): Promise<ScheduleReport> {
    if (input.enabled && !this.service.limits(user).scheduling) {
      throw new HttpError(403, "plan_required", "每日定时生成是 Pro 功能。");
    }
    if (!isValidTime(input.time)) throw new HttpError(400, "invalid_time", "时间格式应为 HH:MM。");
    if (!isValidTimeZone(input.timezone)) {
      throw new HttpError(400, "invalid_timezone", "不认识这个时区。");
    }
    if (input.repoId !== null) this.service.requireRepo(user, input.repoId);
    if (input.enabled && input.repoId === null) {
      throw new HttpError(400, "repo_required", "请选择要生成的仓库。");
    }
    if (input.platforms.length === 0)
      throw new HttpError(400, "platforms_required", "至少选择一个平台。");
    if (input.notifyEmail && !emailPattern.test(input.notifyEmail)) {
      throw new HttpError(400, "invalid_email", "邮箱格式不正确。");
    }
    if (input.webhookUrl) {
      await assertPublicWebhookUrl(input.webhookUrl, this.deps.resolve);
      this.service.credentials.set(
        user.id,
        WEBHOOK_CREDENTIAL,
        input.webhookUrl,
        new URL(input.webhookUrl).host,
      );
    } else if (input.webhookUrl === "") {
      this.service.credentials.delete(user.id, WEBHOOK_CREDENTIAL);
    }
    const previous = this.store.get(user.id);
    this.store.save(user.id, {
      enabled: input.enabled,
      repoId: input.repoId,
      time: input.time,
      timezone: input.timezone,
      platforms: input.platforms,
      windowHours: input.windowHours,
      skipEmpty: input.skipEmpty,
      notifyEmail: input.notifyEmail,
      webhookKind: input.webhookUrl === "" ? null : input.webhookKind,
    });
    // Turning it on (or moving the time) after today's slot starts tomorrow, not right now.
    const changed =
      !previous.enabled || previous.time !== input.time || previous.timezone !== input.timezone;
    if (input.enabled && changed) {
      const local = zonedParts(this.service.now(), input.timezone);
      if (local.time >= input.time) this.store.claimDay(user.id, local.day);
    }
    return this.report(user);
  }

  private async notify(
    user: CurrentUser,
    schedule: StoredSchedule,
    digest: Digest,
  ): Promise<{
    sent: string[];
    errors: string[];
  }> {
    const sent: string[] = [];
    const errors: string[] = [];
    if (schedule.notifyEmail && this.deps.mailer) {
      try {
        await this.deps.mailer.send(schedule.notifyEmail, digest);
        sent.push("email");
      } catch (error) {
        errors.push(toHttpError(error)?.message ?? "邮件发送失败。");
      }
    }
    const webhook = this.webhookUrl(user);
    if (webhook && schedule.webhookKind) {
      try {
        await sendWebhook(webhook, schedule.webhookKind, digest, {
          fetchImpl: this.deps.fetchImpl,
          resolve: this.deps.resolve,
        });
        sent.push("webhook");
      } catch (error) {
        errors.push(toHttpError(error)?.message ?? "Webhook 发送失败。");
      }
    }
    return { sent, errors };
  }

  async sendTest(user: CurrentUser): Promise<{ sent: string[]; errors: string[] }> {
    const schedule = this.store.get(user.id);
    const digest: Digest = {
      subject: "ShipLog 测试提醒",
      text: "这是一条测试提醒。每天生成开发日记后，你会在这里收到摘要和链接。",
      url: `${this.service.config.publicBaseUrl}/#schedule`,
      generationId: null,
    };
    const result = await this.notify(user, schedule, digest);
    if (result.sent.length === 0 && result.errors.length === 0) {
      throw new HttpError(400, "no_channels", "还没有配置邮件或 Webhook。");
    }
    return result;
  }

  /** Run one user's job now: generate, save, notify, and log the outcome. */
  async runFor(userId: number, trigger: ScheduleRun["trigger"]): Promise<ScheduleRun> {
    const record = this.service.users.get(userId);
    const runId = this.store.startRun(userId, trigger, this.service.now());
    const finish = (outcome: Parameters<ScheduleStore["finishRun"]>[1]) => {
      this.store.finishRun(runId, outcome, this.service.now());
      return this.store.runs(userId, 1)[0]!;
    };
    if (!record) return finish({ status: "failed", message: "用户不存在。" });
    const user = this.service.toCurrentUser(record);
    const schedule = this.store.get(userId);
    if (!this.service.limits(user).scheduling) {
      return finish({ status: "skipped", message: "每日定时生成是 Pro 功能。" });
    }
    if (schedule.repoId === null) return finish({ status: "skipped", message: "没有选择仓库。" });
    try {
      const now = this.service.now();
      const window = {
        since: new Date(now.getTime() - schedule.windowHours * 3600_000).toISOString(),
        until: now.toISOString(),
      };
      const today = zonedParts(now, schedule.timezone).day;
      const result = await this.service.generateIfAny(
        user,
        schedule.repoId,
        window,
        schedule.platforms,
        today,
        schedule.skipEmpty,
      );
      if (!result)
        return finish({ status: "skipped", message: "这段时间没有新的提交，没有生成。" });
      const { sent, errors } = await this.notify(
        user,
        schedule,
        buildDigest(result, this.service.config.publicBaseUrl),
      );
      return finish({
        status: "success",
        generationId: result.id,
        message: errors.length > 0 ? `已生成，但提醒发送失败：${errors.join("；")}` : null,
        notified: sent,
      });
    } catch (error) {
      const mapped = toHttpError(error);
      if (!mapped)
        console.error(
          "[shiplog] scheduled run failed:",
          error instanceof Error ? error.message : error,
        );
      return finish({ status: "failed", message: mapped?.message ?? "生成失败，请稍后重试。" });
    }
  }

  /** One scheduler pass over every enabled schedule that is due. */
  async tick(): Promise<number> {
    const now = this.service.now();
    let ran = 0;
    for (const schedule of this.store.listEnabled()) {
      if (!isValidTimeZone(schedule.timezone)) continue;
      const { due, day } = isDue(schedule, now);
      if (!due || !this.store.claimDay(schedule.userId, day)) continue;
      await this.runFor(schedule.userId, "schedule");
      ran += 1;
    }
    return ran;
  }
}

/** Ticks every minute; a slow pass is never overlapped by the next one. */
export class SchedulerLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly schedules: ScheduleService,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pass(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.schedules.tick();
    } catch (error) {
      console.error(
        "[shiplog] scheduler pass failed:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.running = false;
    }
  }
}
