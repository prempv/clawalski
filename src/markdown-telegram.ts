import { telegramFormat } from "telegram-markdown-formatter";

const MAX_LENGTH = 4096;
const TRACKED_TAGS = new Set([
	"b",
	"i",
	"u",
	"s",
	"code",
	"pre",
	"a",
	"span",
	"blockquote",
]);

/**
 * Convert markdown (as produced by Claude) to Telegram-compatible HTML.
 * Returns the raw text unchanged if conversion produces an empty result.
 */
export function markdownToTelegramHtml(markdown: string): string {
	const html = telegramFormat(markdown);
	return html || markdown;
}

/**
 * Split an HTML string into chunks that fit within Telegram's 4096-char limit.
 * Each chunk is independently balanced: tags that would span a boundary are
 * closed at the end of one chunk and re-opened at the start of the next,
 * preserving attributes verbatim (e.g. `<blockquote expandable>`).
 */
export function splitHtml(html: string): string[] {
	const chunks: string[] = [];
	// Preserve <pre> / <pre><code> blocks atomically — split them separately.
	const preRegex =
		/(<pre><code[^>]*>[\s\S]*?<\/code><\/pre>|<pre>[\s\S]*?<\/pre>)/g;
	const parts = html.split(preRegex);

	for (const part of parts) {
		if (!part) continue;
		if (part.startsWith("<pre>") || part.startsWith("<pre><code")) {
			chunks.push(...splitPreBlock(part));
		} else {
			chunks.push(...splitFlowingHtml(part));
		}
	}

	return mergeChunks(chunks);
}

interface OpenTag {
	name: string;
	/** Raw attribute string (including leading space), re-emitted verbatim. */
	raw: string;
}

class TagTracker {
	openTags: OpenTag[] = [];

	feed(html: string): void {
		const tagRegex = /<(\/?)([a-zA-Z0-9]+)([^>]*)>/g;
		for (const m of html.matchAll(tagRegex)) {
			const isClosing = m[1] === "/";
			const name = m[2] as string;
			if (!TRACKED_TAGS.has(name)) continue;
			if (isClosing) {
				for (let i = this.openTags.length - 1; i >= 0; i--) {
					if (this.openTags[i]?.name === name) {
						this.openTags.splice(i, 1);
						break;
					}
				}
			} else {
				this.openTags.push({ name, raw: m[3] ?? "" });
			}
		}
	}

	openHtml(): string {
		return this.openTags.map((t) => `<${t.name}${t.raw}>`).join("");
	}

	closeHtml(): string {
		return [...this.openTags]
			.reverse()
			.map((t) => `</${t.name}>`)
			.join("");
	}

	clone(): TagTracker {
		const t = new TagTracker();
		t.openTags = this.openTags.map((o) => ({ name: o.name, raw: o.raw }));
		return t;
	}
}

function splitFlowingHtml(text: string): string[] {
	const chunks: string[] = [];
	const tracker = new TagTracker();
	// Split points: blank lines, <br>, or single newlines.
	const blocks = text.split(/(\n\s*\n|<br\s*\/?>(?:\n)?|\n)/);

	let openPrefix = "";
	let current = "";

	const flush = (): void => {
		if (!current) return;
		const close = tracker.closeHtml();
		chunks.push(openPrefix + current + close);
		openPrefix = tracker.openHtml();
		current = "";
	};

	for (const block of blocks) {
		if (block === undefined || block === "") continue;

		// Predict the chunk length if we append this block (with closing tags).
		const peek = tracker.clone();
		peek.feed(block);
		const wouldBeLen =
			openPrefix.length +
			current.length +
			block.length +
			peek.closeHtml().length;

		if (wouldBeLen > MAX_LENGTH && current) {
			flush();
		}

		current += block;
		tracker.feed(block);
	}

	flush();
	return chunks;
}

function splitPreBlock(preBlock: string): string[] {
	const langAware = preBlock.match(
		/^<pre><code([^>]*)>([\s\S]*)<\/code><\/pre>$/,
	);
	if (langAware) {
		const [, attr = "", content = ""] = langAware;
		return splitPreLines(content, `<pre><code${attr}>`, "</code></pre>");
	}
	const inner = preBlock.slice(5, -6);
	return splitPreLines(inner, "<pre>", "</pre>");
}

function splitPreLines(
	content: string,
	openTag: string,
	closeTag: string,
): string[] {
	const overhead = openTag.length + closeTag.length;
	const chunks: string[] = [];
	const pieces = content.split(/(\r?\n)/);
	let buf = "";
	for (const piece of pieces) {
		if (buf.length + piece.length + overhead > MAX_LENGTH && buf) {
			chunks.push(openTag + buf + closeTag);
			buf = "";
		}
		buf += piece;
	}
	if (buf) chunks.push(openTag + buf + closeTag);
	return chunks;
}

function mergeChunks(chunks: string[]): string[] {
	const merged: string[] = [];
	let buf = "";
	for (const c of chunks) {
		if (!buf) {
			buf = c;
		} else if (buf.length + c.length <= MAX_LENGTH) {
			buf += c;
		} else {
			merged.push(buf);
			buf = c;
		}
	}
	if (buf) merged.push(buf);
	return merged;
}
