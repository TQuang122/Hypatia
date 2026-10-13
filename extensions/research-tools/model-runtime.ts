import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type { SubagentModelRole, SubagentModelRoutes, SubagentThinkingLevel, SubagentThinkingOverride } from "../../src/model/role-routing.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Published extensions ship beside dist/, while src/ exists only in a checkout.
// This module uses source types solely at compile time.
const routes = createRequire(import.meta.url)(join(root, "dist/model/role-routing.js")) as typeof import("../../src/model/role-routing.js");
export const clearSubagentModelOverride = routes.clearSubagentModelOverride;
export const getConfiguredParentModel = routes.getConfiguredParentModel;
export const getSubagentModelOverride = routes.getSubagentModelOverride;
export const getSubagentThinkingOverride = routes.getSubagentThinkingOverride;
export const readSubagentModelRoutes = routes.readSubagentModelRoutes;
export const readSubagentModelSettings = routes.readSubagentModelSettings;
export const resolveSubagentModelRoutes = routes.resolveSubagentModelRoutes;
export const SUBAGENT_MODEL_ROLES = routes.SUBAGENT_MODEL_ROLES;
export const SUBAGENT_THINKING_LEVELS = routes.SUBAGENT_THINKING_LEVELS;
export const setSubagentThinkingOverride = routes.setSubagentThinkingOverride;
export const writeSubagentModelRoutes = routes.writeSubagentModelRoutes;
export async function getAvailableModelRecords(authPath: string): ReturnType<typeof import("../../src/model/catalog.js").getAvailableModelRecords> {
  const catalog = await import(pathToFileURL(join(root, "dist/model/catalog.js")).href) as typeof import("../../src/model/catalog.js");
  return catalog.getAvailableModelRecords(authPath);
}
