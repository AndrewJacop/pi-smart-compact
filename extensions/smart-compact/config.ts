// Config loading and validation for the `smartCompact` settings key (SPEC §5.3).
// Invalid config fails loud: warn, smart path off, native compaction, never guess.

export type Action = "keep" | "summarize" | "drop";
export type UnitType = "user" | "previous-summary" | "assistant-text" | "thinking" | "tool-call" | "tool-result";
export type Mode = "live" | "shadow" | "off";
export type Privacy = "redacted" | "full";

export const ACTIONS: readonly Action[] = ["keep", "summarize", "drop"];
export const UNIT_TYPES: readonly UnitType[] = [
	"user",
	"previous-summary",
	"assistant-text",
	"thinking",
	"tool-call",
	"tool-result",
];
export const MODES: readonly Mode[] = ["live", "shadow", "off"];
export const PRIVACIES: readonly Privacy[] = ["redacted", "full"];

export interface ProfileOverride {
	model?: string;
	maxQuestions?: number;
	stateTokenBudget?: number;
	truncateStateClientSide?: boolean;
	confidenceFloor?: number;
}

export interface SmartCompactConfig {
	backend: string;
	mode: Mode;
	privacy: Privacy;
	minReductionPct: number;
	/** Unset = pi default (native keepRecentTokens window). 0 = no-op. */
	keptMessages: number | undefined;
	decisionTimeoutMs: number;
	matrix: Record<UnitType, Action[]>;
	profiles: Record<string, ProfileOverride>;
}

export const DEFAULT_BACKEND = "clef";
export const DEFAULT_MIN_REDUCTION_PCT = 50;
export const DEFAULT_DECISION_TIMEOUT_MS = 5000;

/** The Safe table (SPEC §4): rows the user's matrix may override per row. */
export const DEFAULT_MATRIX: Record<UnitType, Action[]> = {
	user: ["keep"],
	"previous-summary": ["keep"],
	"assistant-text": ["keep", "summarize"],
	thinking: ["summarize", "drop"],
	"tool-call": ["keep", "drop"],
	"tool-result": ["keep", "summarize", "drop"],
};

/** Shipped backend profiles (SPEC §5.2) and the env var that unlocks each (§5.4). */
export const BACKENDS: Record<string, { env: string | null }> = {
	clef: { env: "OPTOLLM_API_KEY" },
	jev: { env: "FREEJEV_API_KEY" },
	"jev-direct": { env: "TYPESAFE_API_KEY" }, // provisional name — §5.4 doesn't name it; confirm in ticket 08
	ollama: { env: null },
};
// Shipped per-profile defaults (§5.2/§8.5: confidenceFloor 0.1 shared, clef truncateStateClientSide,
// per-profile model/maxQuestions) land with their consumers — the adapters (tickets 02/08).

const PROFILE_FIELDS: Record<string, "string" | "int" | "boolean" | "floor"> = {
	model: "string",
	maxQuestions: "int",
	stateTokenBudget: "int",
	truncateStateClientSide: "boolean",
	confidenceFloor: "floor",
};

export type ValidatedConfig = { ok: true; config: SmartCompactConfig } | { ok: false; errors: string[] };

function typeName(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

export function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate the raw `smartCompact` settings value against the shipped schema. */
export function validateSmartCompact(raw: unknown): ValidatedConfig {
	if (raw === undefined || raw === null) return { ok: true, config: defaults() };
	if (!isObject(raw)) return { ok: false, errors: [`smartCompact must be an object, got ${typeName(raw)}`] };

	const errors: string[] = [];

	const known = new Set(["backend", "mode", "privacy", "minReductionPct", "keptMessages", "decisionTimeoutMs", "matrix", "profiles"]);
	const unknownKeys = Object.keys(raw).filter((k) => !known.has(k));
	if (unknownKeys.length > 0) {
		errors.push(`unknown smartCompact knob(s): ${unknownKeys.join(", ")}`);
	}

	let backend = DEFAULT_BACKEND;
	if (raw.backend !== undefined) {
		if (typeof raw.backend === "string" && raw.backend in BACKENDS) {
			backend = raw.backend;
		} else {
			errors.push(`smartCompact.backend must be one of ${Object.keys(BACKENDS).join(", ")}, got ${JSON.stringify(raw.backend)}`);
		}
	}

	if (raw.mode !== undefined && !(MODES as readonly string[]).includes(raw.mode as string)) {
		errors.push(`smartCompact.mode must be one of ${MODES.map((m) => `"${m}"`).join(", ")}, got ${JSON.stringify(raw.mode)}`);
	}

	if (raw.privacy !== undefined && !(PRIVACIES as readonly string[]).includes(raw.privacy as string)) {
		errors.push(`smartCompact.privacy must be one of ${PRIVACIES.map((p) => `"${p}"`).join(", ")}, got ${JSON.stringify(raw.privacy)}`);
	}

	let minReductionPct = DEFAULT_MIN_REDUCTION_PCT;
	if (raw.minReductionPct !== undefined) {
		const v = raw.minReductionPct;
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
			errors.push(`smartCompact.minReductionPct must be a number between 0 and 100, got ${JSON.stringify(v)}`);
		} else {
			minReductionPct = v;
		}
	}

	let keptMessages: number | undefined;
	if (raw.keptMessages !== undefined) {
		if (typeof raw.keptMessages === "number" && Number.isInteger(raw.keptMessages) && raw.keptMessages >= 0) {
			keptMessages = raw.keptMessages;
		} else {
			errors.push(`smartCompact.keptMessages must be a non-negative integer, got ${JSON.stringify(raw.keptMessages)}`);
		}
	}

	let decisionTimeoutMs = DEFAULT_DECISION_TIMEOUT_MS;
	if (raw.decisionTimeoutMs !== undefined) {
		if (typeof raw.decisionTimeoutMs === "number" && Number.isInteger(raw.decisionTimeoutMs) && raw.decisionTimeoutMs > 0) {
			decisionTimeoutMs = raw.decisionTimeoutMs;
		} else {
			errors.push(`smartCompact.decisionTimeoutMs must be a positive integer, got ${JSON.stringify(raw.decisionTimeoutMs)}`);
		}
	}

	const matrix = { ...DEFAULT_MATRIX };
	if (raw.matrix !== undefined) {
		if (!isObject(raw.matrix)) {
			errors.push(`smartCompact.matrix must be an object, got ${typeName(raw.matrix)}`);
		} else {
			for (const [unit, row] of Object.entries(raw.matrix)) {
				const path = `smartCompact.matrix.${unit}`;
				if (!(UNIT_TYPES as readonly string[]).includes(unit)) {
					errors.push(`${path} is not a known unit type (${UNIT_TYPES.join(", ")})`);
					continue;
				}
				if (!Array.isArray(row) || row.length === 0) {
					errors.push(`${path} must be a non-empty array of actions`);
					continue;
				}
				const seen = new Set<string>();
				const actions: Action[] = [];
				let rowBad = false;
				for (const a of row) {
					if (!(ACTIONS as readonly string[]).includes(a as Action)) {
						errors.push(`${path} contains unknown action ${JSON.stringify(a)} (${ACTIONS.join(", ")})`);
						rowBad = true;
					} else if (seen.has(a as string)) {
						errors.push(`${path} contains duplicate action "${a}"`);
						rowBad = true;
					} else {
						seen.add(a as string);
						actions.push(a as Action);
					}
				}
				if (!rowBad) matrix[unit as UnitType] = actions;
			}
		}
	}

	const profiles: Record<string, ProfileOverride> = {};
	if (raw.profiles !== undefined) {
		if (!isObject(raw.profiles)) {
			errors.push(`smartCompact.profiles must be an object, got ${typeName(raw.profiles)}`);
		} else {
			for (const [name, override] of Object.entries(raw.profiles)) {
				const path = `smartCompact.profiles.${name}`;
				if (!(name in BACKENDS)) {
					errors.push(`${path} is not a known profile (${Object.keys(BACKENDS).join(", ")})`);
					continue;
				}
				if (!isObject(override)) {
					errors.push(`${path} must be an object, got ${typeName(override)}`);
					continue;
				}
				const clean: ProfileOverride = {};
				let bad = false;
				for (const [field, value] of Object.entries(override)) {
					const kind = PROFILE_FIELDS[field];
					const fpath = `${path}.${field}`;
					if (kind === undefined) {
						errors.push(`${path} has unknown field ${field} (${Object.keys(PROFILE_FIELDS).join(", ")})`);
						bad = true;
					} else if (kind === "string") {
						if (typeof value !== "string" || value.length === 0) errors.push(`${fpath} must be a non-empty string, got ${JSON.stringify(value)}`);
						else clean.model = value;
					} else if (kind === "boolean") {
						if (typeof value !== "boolean") errors.push(`${fpath} must be a boolean, got ${JSON.stringify(value)}`);
						else clean.truncateStateClientSide = value;
					} else if (kind === "int") {
						if (typeof value === "number" && Number.isInteger(value) && value > 0) {
							if (field === "maxQuestions") clean.maxQuestions = value;
							else clean.stateTokenBudget = value;
						} else {
							errors.push(`${fpath} must be a positive integer, got ${JSON.stringify(value)}`);
						}
					} else {
						if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
							errors.push(`${fpath} must be a number between 0 and 1, got ${JSON.stringify(value)}`);
						} else {
							clean.confidenceFloor = value;
						}
					}
				}
				if (!bad) profiles[name] = clean;
			}
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		config: {
			...defaults(),
			backend,
			mode: (raw.mode as Mode) ?? "live",
			privacy: (raw.privacy as Privacy) ?? "redacted",
			minReductionPct,
			keptMessages,
			decisionTimeoutMs,
			matrix,
			profiles,
		},
	};
}

function defaults(): SmartCompactConfig {
	return {
		backend: DEFAULT_BACKEND,
		mode: "live",
		privacy: "redacted",
		minReductionPct: DEFAULT_MIN_REDUCTION_PCT,
		keptMessages: undefined,
		decisionTimeoutMs: DEFAULT_DECISION_TIMEOUT_MS,
		matrix: { ...DEFAULT_MATRIX },
		profiles: {},
	};
}

/** Rung 0 pre-flight (SPEC §8): the env var that must be set for this backend, or null. Reads live. */
export function missingBackendKey(backend: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const entry = BACKENDS[backend];
	if (!entry || entry.env === null) return null;
	return env[entry.env] ? null : entry.env;
}
