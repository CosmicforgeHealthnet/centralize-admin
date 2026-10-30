import api from "./api";
import type { EmergencyStop, Readiness, RolloutCohort, RolloutOverview, RolloutRule } from "@/types/mail-rollout.types";

const BASE = "/api/mail/v1/admin";
const unwrap = <T>(response: { data: { data: T } }) => response.data.data;

export const rolloutOverview = async () => unwrap<RolloutOverview>(await api.get(`${BASE}/rollout`));
export const rolloutReadiness = async () => unwrap<Readiness>(await api.get(`${BASE}/rollout/readiness`));
export const createRolloutRule = async (input: { capability: string; scopeType: string; scopeId?: string | null; effect: string; reason: string; stepUpId?: string }) =>
  unwrap<RolloutRule>(await api.post(`${BASE}/rollout/rules`, input));
export const revokeRolloutRule = async (id: string, stepUpId?: string) => unwrap<RolloutRule>(await api.post(`${BASE}/rollout/rules/${id}/revoke`, stepUpId ? { stepUpId } : {}));
export const createCohort = async (input: { key: string; name: string }) => unwrap<RolloutCohort>(await api.post(`${BASE}/rollout/cohorts`, input));
export const addCohortMember = async (cohortId: string, adminUserId: string) => unwrap<unknown>(await api.post(`${BASE}/rollout/cohorts/${cohortId}/members`, { adminUserId }));
export const removeCohortMember = async (cohortId: string, adminUserId: string) => unwrap<unknown>(await api.delete(`${BASE}/rollout/cohorts/${cohortId}/members/${adminUserId}`));
export const activateEmergencyStop = async (input: { scope: string; organizationId?: string; reason: string }) => unwrap<EmergencyStop>(await api.post(`${BASE}/emergency-stops`, input));
export const releaseEmergencyStop = async (id: string, stepUpId: string) => unwrap<EmergencyStop>(await api.post(`${BASE}/emergency-stops/${id}/release`, { stepUpId }));
