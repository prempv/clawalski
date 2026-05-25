const SECRET_VALUE = "[REDACTED]";
const BROWSERBASE_PREFIX = ["bb", "live", ""].join("_");

const TOKEN_PATTERNS: RegExp[] = [
	new RegExp(`\\b${BROWSERBASE_PREFIX}[A-Za-z0-9_-]{16,}\\b`, "g"),
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
	/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
];

const LABELLED_SECRET_PATTERN =
	/\b((?:api[_\s-]?key|project[_\s-]?key|secret|access[_\s-]?token|refresh[_\s-]?token|auth[_\s-]?token|bearer|password|token)\s*[:=]\s*)([^\s'",;]{12,})/gi;

export function redactSensitiveText(text: string): string {
	let redacted = text.replace(
		LABELLED_SECRET_PATTERN,
		(_match, prefix: string) => `${prefix}${SECRET_VALUE}`,
	);
	for (const pattern of TOKEN_PATTERNS) {
		redacted = redacted.replace(pattern, SECRET_VALUE);
	}
	return redacted;
}

export function redactedPreview(
	text: string | null | undefined,
	limit = 200,
): string {
	if (!text) return "";
	return redactSensitiveText(text).slice(0, limit);
}
