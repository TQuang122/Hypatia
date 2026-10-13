import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODEL_ACCESS_ERROR = /\bmodel[_ -]not[_ -](?:supported|found)\b|(?:unsupported|unavailable)\s+model\b|\bmodel\b.{0,80}\b(?:not supported|not available|unavailable|not found|cannot be used|can't use|cannot use|not allowed|not usable|invalid)\b|\b(?:account|provider|organization).{0,80}\b(?:cannot|can't|does not|doesn't)\b.{0,30}\bmodel\b/i;
const NO_CREDITS_ERROR = /insufficient[_ -](?:quota|credits?|funds|balance)|(?:no|out of|exhausted) credits?|credit balance|billing[_ -]hard[_ -]limit/i;
const RATE_LIMIT_ERROR = /\b429\b|rate[_ -]?limit|too many requests|quota.{0,40}(?:exceeded|exhausted|used up)|resource[_ -]exhausted|usage limit/i;
const CONTEXT_LIMIT_ERROR = /context (?:length|window).{0,40}(?:exceeded|maximum|limit)|maximum context|prompt.{0,40}(?:too long|token limit)|too many tokens/i;
const CREDENTIALS_ERROR = /\b401\b|\b403\b|unauthori[sz]ed|invalid[_ -](?:api[_ -]?key|credential|token|grant)|authentication.{0,40}(?:failed|error|rejected|denied)|credentials?.{0,40}(?:invalid|rejected)|access denied/i;
const PROVIDER_OUTAGE_ERROR = /\b5\d\d\b|temporarily unavailable|service unavailable|server error|overloaded|at capacity|servers? (?:are )?busy|connection (?:error|reset|refused)|econnreset|etimedout|timed out|fetch failed|socket hang up/i;

export function modelErrorRecoveryGuidance(errorMessage: string): string | undefined {
	if (MODEL_ACCESS_ERROR.test(errorMessage)) {
		return "This account may not have access to the selected model. Choose an available model with `/model`.";
	}
	if (NO_CREDITS_ERROR.test(errorMessage)) {
		return "The provider reports no remaining credits. Check its billing or credit balance, or choose another provider/model.";
	}
	if (RATE_LIMIT_ERROR.test(errorMessage)) {
		return "The provider reports a rate limit or exhausted quota. Check usage limits, wait for the reset, or retry with another model.";
	}
	if (CONTEXT_LIMIT_ERROR.test(errorMessage)) {
		return "The request exceeds this model's context window. Shorten the input or choose a model with a larger context window.";
	}
	if (CREDENTIALS_ERROR.test(errorMessage)) {
		return "The provider rejected its credentials or access. Run `hypatia model login <provider>` or update its API key, then retry.";
	}
	if (PROVIDER_OUTAGE_ERROR.test(errorMessage)) {
		return "The provider appears temporarily unavailable. Retry after a short pause, check its service status, or choose another configured model.";
	}
	return undefined;
}

export function registerModelErrorGuidance(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error" || !message.errorMessage) return;
		if (message.errorMessage.includes("Hypatia recovery:")) return;
		const guidance = modelErrorRecoveryGuidance(message.errorMessage);
		if (!guidance) return;
		return {
			message: {
				...message,
				errorMessage: `${message.errorMessage}\n\nHypatia recovery: ${guidance}`,
			},
		};
	});
}
