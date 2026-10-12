import { Flame, Share2, Trophy } from "lucide-react";
import type { ActivityReport } from "../../shared/schemas";
import { useI18n } from "../i18n";

function level(commits: number): number {
  if (commits <= 0) return 0;
  if (commits === 1) return 1;
  if (commits <= 3) return 2;
  if (commits <= 6) return 3;
  return 4;
}

/**
 * Calendar heatmap: one column per week, one row per weekday. Commits use a one-hue
 * sequential ramp; shared days add a dot so meaning never depends on color alone.
 */
export function ActivityHeatmap({ report }: { report: ActivityReport }) {
  const { t } = useI18n();
  const days = report.days;
  const firstWeekday = days.length > 0 ? new Date(`${days[0]!.day}T00:00:00Z`).getUTCDay() : 0;
  const padded: Array<(typeof days)[number] | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...days,
  ];
  const weeks: Array<typeof padded> = [];
  for (let index = 0; index < padded.length; index += 7) weeks.push(padded.slice(index, index + 7));
  const active = days.filter((day) => day.commits > 0).length;
  const shared = days.filter((day) => day.shared).length;

  return (
    <section className="panel activity" aria-labelledby="activity-title">
      <h2 id="activity-title" className="panel-title">
        {t("activity.title")}
      </h2>
      <div className="streaks">
        <div className="streak">
          <Flame aria-hidden="true" size={20} className="streak-icon streak-commit" />
          <div>
            <div className="streak-value">{t("activity.days", { n: report.commitStreak })}</div>
            <div className="streak-label">{t("activity.commitStreak")}</div>
          </div>
        </div>
        <div className="streak">
          <Share2 aria-hidden="true" size={20} className="streak-icon streak-share" />
          <div>
            <div className="streak-value">{t("activity.days", { n: report.shareStreak })}</div>
            <div className="streak-label">{t("activity.shareStreak")}</div>
          </div>
        </div>
        <div className="streak">
          <Trophy aria-hidden="true" size={20} className="streak-icon" />
          <div>
            <div className="streak-value">
              {t("activity.days", { n: report.longestCommitStreak })}
            </div>
            <div className="streak-label">{t("activity.longest")}</div>
          </div>
        </div>
      </div>
      <div
        className="heatmap"
        role="img"
        aria-label={t("activity.summary", { weeks: weeks.length, active, shared })}
      >
        {weeks.map((week, weekIndex) => (
          <div className="heatmap-week" key={weekIndex}>
            {week.map((day, dayIndex) =>
              day ? (
                <span
                  key={day.day}
                  className={`heat-cell heat-${level(day.commits)}${day.shared ? " heat-shared" : ""}`}
                  title={t("activity.cell", {
                    day: day.day,
                    commits: day.commits,
                    shared: day.shared ? t("activity.cellShared") : "",
                  })}
                />
              ) : (
                <span key={`pad-${dayIndex}`} className="heat-cell heat-pad" aria-hidden="true" />
              ),
            )}
          </div>
        ))}
      </div>
      <div className="heatmap-legend">
        <span className="legend-item">
          <span className="legend-ramp" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((value) => (
              <span key={value} className={`heat-cell heat-${value}`} />
            ))}
          </span>
          {t("activity.legend.commits")}
        </span>
        <span className="legend-item">
          <span className="heat-cell heat-2 heat-shared" aria-hidden="true" />
          {t("activity.legend.shared")}
        </span>
      </div>
    </section>
  );
}
