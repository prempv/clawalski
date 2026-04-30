import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml, splitHtml } from "../markdown-telegram.js";

const MAX = 4096;

function countTag(haystack: string, pattern: RegExp): number {
	return (haystack.match(pattern) ?? []).length;
}

/**
 * A well-formed chunk has every tracked open tag matched by a close tag.
 * (This is a weaker but sufficient check for the splitter: balance, not nesting order.)
 */
function isBalanced(chunk: string): boolean {
	const tags = ["b", "i", "u", "s", "code", "pre", "a", "span", "blockquote"];
	for (const tag of tags) {
		const opens = countTag(chunk, new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g"));
		const closes = countTag(chunk, new RegExp(`</${tag}>`, "g"));
		if (opens !== closes) return false;
	}
	return true;
}

describe("splitHtml", () => {
	it("returns single chunk when under limit", () => {
		const html = "<b>hello</b>\n\n<i>world</i>";
		expect(splitHtml(html)).toEqual([html]);
	});

	it("keeps each chunk within MAX_LENGTH", () => {
		const para = `${"word ".repeat(500)}\n\n`.trim();
		const html = `${para}\n\n${para}\n\n${para}`;
		const chunks = splitHtml(html);
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(MAX);
		}
	});

	it("balances tags when a blockquote spans a boundary", () => {
		const filler = "a ".repeat(2500); // ~5000 chars inside blockquote
		const paragraphs = (filler.trim().match(/.{1,80}/g) ?? []).join("\n");
		const html = `<blockquote expandable>${paragraphs}</blockquote>\n\n<b>final</b>`;
		const chunks = splitHtml(html);

		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(MAX);
			expect(isBalanced(c)).toBe(true);
		}
	});

	it("preserves boolean attributes across chunk boundaries", () => {
		// Force a split inside the blockquote — the reopened tag must keep `expandable`.
		const lines = Array.from(
			{ length: 120 },
			(_, i) => `line ${i} ${"x".repeat(50)}`,
		).join("\n");
		const html = `<blockquote expandable>${lines}</blockquote>`;
		const chunks = splitHtml(html);

		expect(chunks.length).toBeGreaterThan(1);
		// Every chunk that contains blockquote content should carry the expandable attr.
		for (const c of chunks) {
			const opens = c.match(/<blockquote[^>]*>/g) ?? [];
			for (const tag of opens) {
				expect(tag).toBe("<blockquote expandable>");
			}
		}
	});

	it("does not double-open a tag on the first chunk (regression)", () => {
		const lines = Array.from(
			{ length: 120 },
			(_, i) => `line ${i} ${"x".repeat(50)}`,
		).join("\n");
		const html = `<blockquote expandable>${lines}</blockquote>\n\n<b>final</b>`;
		const chunks = splitHtml(html);
		const first = chunks[0] ?? "";

		const opens = (first.match(/<blockquote[^>]*>/g) ?? []).length;
		expect(opens).toBe(1);
	});

	it("keeps <pre><code> blocks atomic and splits them internally", () => {
		const line = `${"x".repeat(80)}\n`;
		const code = line.repeat(80); // ~6500 chars with frequent newlines
		const html = `<pre><code class="language-ts">${code}</code></pre>`;
		const chunks = splitHtml(html);

		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(MAX);
			expect(c.startsWith("<pre><code")).toBe(true);
			expect(c.endsWith("</code></pre>")).toBe(true);
		}
	});

	it("merges small adjacent chunks when they fit", () => {
		const html = "<b>a</b>\n\n<i>b</i>\n\n<u>c</u>";
		expect(splitHtml(html)).toEqual([html]);
	});

	it("handles nested tags at a boundary", () => {
		const inner = "x".repeat(4100);
		const html = `<blockquote expandable><b>${inner}</b></blockquote>`;
		const chunks = splitHtml(html);
		// Input has no natural split points so it may end up as one oversized chunk;
		// the requirement here is only that whatever comes out stays balanced.
		for (const c of chunks) {
			expect(isBalanced(c)).toBe(true);
		}
	});
});

describe("markdownToTelegramHtml", () => {
	it("converts single-backtick inline code", () => {
		expect(markdownToTelegramHtml("see `foo` now")).toBe(
			"see <code>foo</code> now",
		);
	});

	it("collapses double-backtick inline code without leaking literals", () => {
		expect(
			markdownToTelegramHtml("path: ``/home/dev/work/bots/optimus``."),
		).toBe("path: <code>/home/dev/work/bots/optimus</code>.");
	});

	it("leaves fenced code blocks untouched", () => {
		const out = markdownToTelegramHtml("```\nhello\n```");
		expect(out).toContain("<pre>");
		expect(out).toContain("hello");
		expect(out).not.toMatch(/^`/);
	});

	it("does not collapse double-backticks containing a backtick", () => {
		// Legitimate use of double-backticks: the inner content has a single
		// backtick that would otherwise need escaping. Leave alone.
		const input = "see ``a ` b`` here";
		expect(markdownToTelegramHtml(input)).not.toMatch(/<code>a ` b<\/code>/);
	});
});
