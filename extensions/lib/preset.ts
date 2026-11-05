import type { WorkerBackend } from "./backend.ts";
import type { Placement } from "./config.ts";
import { isThinkingLevel, type ThinkingLevel } from "./thinking.ts";

export interface Preset {
	model?: string;
	tools?: string[];
	thinking?: ThinkingLevel;
	isolated?: boolean;
	backend?: WorkerBackend;
}

export interface SpawnPresetValues {
	model?: string;
	tools?: string[];
	thinking?: string | null;
	isolated?: boolean;
	backend?: string;
}

const PRESET_FIELDS = ["model", "tools", "thinking", "isolated", "backend"] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validField(field: (typeof PRESET_FIELDS)[number], value: unknown): boolean {
	switch (field) {
		case "model":
			return typeof value === "string";
		case "tools":
			return Array.isArray(value) && value.every((item) => typeof item === "string");
		case "thinking":
			return isThinkingLevel(value);
		case "isolated":
			return typeof value === "boolean";
		case "backend":
			return value === "omp" || value === "claude" || value === "codex";
	}
}

export function readPresets(value: unknown, guidance: string[]): Record<string, Preset> {
	const presets = Object.create(null) as Record<string, Preset>;
	if (!plainObject(value)) return presets;
	for (const [name, raw] of Object.entries(value)) {
		if (!name) {
			guidance.push("Preset names must not be empty.");
			continue;
		}
		if (!plainObject(raw)) {
			guidance.push(`Preset '${name}' must be an object.`);
			continue;
		}
		let valid = true;
		for (const [field, fieldValue] of Object.entries(raw)) {
			if (!(PRESET_FIELDS as readonly string[]).includes(field)) {
				guidance.push(`Preset '${name}' has an unknown field '${field}'.`);
				valid = false;
			} else if (!validField(field as (typeof PRESET_FIELDS)[number], fieldValue)) {
				guidance.push(`Preset '${name}' has an invalid field '${field}'.`);
				valid = false;
			}
		}
		if (valid) presets[name] = raw as Preset;
	}
	return presets;
}

export function resolveSpawn<T extends SpawnPresetValues>(
	presets: Record<string, Preset>,
	name: string | undefined,
	params: T,
): T | string {
	if (name === undefined) return params;
	if (!Object.hasOwn(presets, name)) {
		const names = Object.keys(presets).sort();
		const available = names.length > 0 ? `Use one of: ${names.join(", ")}.` : "No preset is defined in the configuration file.";
		return `Unknown preset '${name}'. ${available}`;
	}
	const preset = presets[name] ?? {};
	const merged = { ...params } as T;
	for (const field of PRESET_FIELDS) {
		const callValue = params[field];
		const presetValue = preset[field];
		if (callValue === undefined && presetValue !== undefined) {
			(merged as Record<string, unknown>)[field] = presetValue;
		}
	}
	return merged;
}

export function withReportTool(tools: string[] | null): string[] | null {
	if (!tools?.length || tools.includes("wezterm_worker_report")) return tools;
	return [...tools, "wezterm_worker_report"];
}
