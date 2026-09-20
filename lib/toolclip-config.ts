import type { ToolclipConfig } from "./types.ts";

const DEFAULT_THRESHOLD_TOKENS = 250;
const DEFAULT_MAX_REPLACEMENT_RATIO = 0.1;

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
	const raw = env[key];
	if (raw == null || raw.trim() === "") {
		return fallback;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function readRatio(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
	const raw = env[key];
	if (raw == null || raw.trim() === "") {
		return fallback;
	}
	const parsed = Number(raw);
	// Ratio must be strictly positive and at most 1. Anything else -> fallback.
	return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

export function loadToolclipConfig(env: NodeJS.ProcessEnv = process.env): ToolclipConfig {
	return {
		thresholdTokens: readPositiveInt(env, "TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS", DEFAULT_THRESHOLD_TOKENS),
		maxReplacementRatio: readRatio(env, "TOOLCLIP_MAX_REPLACEMENT_RATIO", DEFAULT_MAX_REPLACEMENT_RATIO),
	};
}