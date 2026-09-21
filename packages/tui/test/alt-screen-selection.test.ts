import assert from "node:assert";
import { describe, it } from "node:test";
import {
	applySelectionHighlight,
	getLineSelection,
	getSelectionBounds,
	getSelectionColumns,
	getWordSelection,
} from "../src/alt-screen-selection.ts";
import { stripTerminalSequences } from "../src/utils.ts";

describe("alt-screen selection primitives", () => {
	it("selects the word under the point", () => {
		const range = getWordSelection("hello world", { row: 0, col: 1 });
		assert.deepStrictEqual(range, {
			start: { row: 0, col: 0 },
			end: { row: 0, col: 5, boundary: true },
		});
	});

	it("joins path and kebab-case segments", () => {
		assert.strictEqual(getWordSelection("foo/bar baz", { row: 0, col: 2 })?.end.col, 7);
		assert.strictEqual(getWordSelection("x-y-z rest", { row: 0, col: 2 })?.end.col, 5);
	});

	it("ignores ANSI codes when measuring the word", () => {
		const range = getWordSelection("\x1b[31mhello\x1b[39m world", { row: 0, col: 2 });
		assert.strictEqual(range?.start.col, 0);
		assert.strictEqual(range?.end.col, 5);
	});

	it("selects the entire line", () => {
		assert.deepStrictEqual(getLineSelection("abc界", { row: 3, col: 1 }), {
			start: { row: 3, col: 0 },
			end: { row: 3, col: 5, boundary: true },
		});
	});

	it("orders anchors and rejects empty or cross-scroll selections", () => {
		const first = { row: 0, col: 5 };
		const second = { row: 1, col: 2 };
		assert.deepStrictEqual(getSelectionBounds(first, second), { start: first, end: second });
		assert.deepStrictEqual(getSelectionBounds(second, first), { start: first, end: second });
		assert.strictEqual(getSelectionBounds(first, { ...first }), undefined);
		const scrollA = {} as never;
		const scrollB = {} as never;
		assert.strictEqual(
			getSelectionBounds({ ...first, scrollView: scrollA }, { ...second, scrollView: scrollB }),
			undefined,
		);
	});

	it("snaps selection columns to grapheme boundaries", () => {
		const selection = { start: { row: 0, col: 2 }, end: { row: 0, col: 3 } };
		assert.deepStrictEqual(getSelectionColumns("ab界cd", 0, selection), { start: 2, end: 4 });
	});

	it("highlights text with reverse video while preserving ANSI", () => {
		const result = applySelectionHighlight("a\x1b[31mb\x1b[39m");
		assert.ok(result.startsWith("\x1b[7m"));
		assert.ok(result.endsWith("\x1b[27m"));
		assert.ok(result.includes("\x1b[31m"));
		assert.strictEqual(stripTerminalSequences(result), "ab");
	});
});
