import {registerNativeIdeaForge} from "./research-tools/idea-forge-native.js";
import {registerExperimentChat} from "./research-tools/experiment-chat.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAlphaTools } from "./research-tools/alpha.js";
import { registerCurrentDateResearchContext } from "./research-tools/current-date.js";
import { registerDiscoveryCommands } from "./research-tools/discovery.js";
import { registerBudgetGuard } from "./research-tools/budget-guard.js";
import { registerChatPresentation } from "./research-tools/chat-presentation.js";
import { registerChatTurnOutput, registerTuiModeNotices } from "./research-tools/chat-turn-output.js";
import { registerCodeSearchTool } from "./research-tools/code-search.js";
import { registerContext7Mcp } from "./research-tools/context7-mcp.js";
import { registerDocxFallback } from "./research-tools/docx-fallback.js";
import { registerExperimentWorkflow } from "./research-tools/experiment-workflow.js";
import { registerExperiments } from "./research-tools/experiments.js";
import { installHypatiaHeader } from "./research-tools/header.js";
import { installHypatiaFooter } from "./research-tools/footer.js";
import { registerHelpCommand } from "./research-tools/help.js";
import { registerResumeNudge } from "./research-tools/resume-nudge.js";
import { registerSecretScrubber } from "./research-tools/secret-scrubber.js";
import { registerUntrustedFence } from "./research-tools/untrusted-fence.js";
import { registerHuggingFaceTools } from "./research-tools/huggingface.js";
import { registerSubagentModelRoutes } from "./research-tools/subagent-models.js";
import { registerSubagentModelRoutesCommand } from "./research-tools/model-routes.js";
import { registerSubagentActivityStatus } from "./research-tools/subagent-activity.js";
import { registerWarningCenter } from "./research-tools/warnings.js";
import { registerInitCommand, registerOutputsCommand } from "./research-tools/project.js";
import { registerServiceTierControls } from "./research-tools/service-tier.js";
import { registerScienceDatabaseTools } from "./research-tools/science-databases.js";
import { registerResearchTelemetry } from "./research-tools/telemetry.js";

export default function researchTools(pi: ExtensionAPI): void {
	registerWarningCenter(pi);
	const presentation = registerChatPresentation(pi);
	const turnOutput = registerChatTurnOutput(pi);
	const tuiModeNotices = registerTuiModeNotices(pi);
	// Pi 0.66.x folds post-switch/resume lifecycle into session_start.
	pi.on("session_start", (_event, ctx) => {
		installHypatiaHeader(ctx, tuiModeNotices.observeRuntimeMode);
		installHypatiaFooter(ctx);
	});

	registerAlphaTools(pi);
	registerCurrentDateResearchContext(pi);
	registerHuggingFaceTools(pi);
	registerDiscoveryCommands(pi);
	registerDocxFallback(pi);
	registerExperimentWorkflow(pi);
	registerExperiments(pi);
	registerNativeIdeaForge(pi);
	registerExperimentChat(pi);
	registerSecretScrubber(pi);
	registerUntrustedFence(pi);
	registerBudgetGuard(pi);
	registerCodeSearchTool(pi);
	registerContext7Mcp(pi);
	registerSubagentModelRoutes(pi);
	registerSubagentModelRoutesCommand(pi);
	registerSubagentActivityStatus(pi, { onActivityChange: (busy, working) => {
		presentation.setActivity(busy, working);
		turnOutput.setActivity(busy, working);
	} });
	registerResumeNudge(pi);
	registerHelpCommand(pi);
	registerInitCommand(pi);
	registerOutputsCommand(pi);
	registerServiceTierControls(pi);
	registerScienceDatabaseTools(pi);
	registerResearchTelemetry(pi);
}
