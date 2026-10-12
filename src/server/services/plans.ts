import type { Plan, PlanLimits } from "../../shared/schemas.js";

export const planLimits: Record<Plan, PlanLimits> = {
  free: { maxRepos: 1, aiRunsPerMonth: 10, voiceLearning: false },
  pro: { maxRepos: null, aiRunsPerMonth: null, voiceLearning: true },
};
