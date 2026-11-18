import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class LinesComponent implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class CapturingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

interface CursorAccess {
	positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void;
	hardwareCursorRow: number;
}

describe("TuiMainScreen scroll preservation", () => {
	it("positions the hidden hardware cursor for IME", () => {
		const terminal = new CapturingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const access = tui as unknown as CursorAccess;
		access.hardwareCursorRow = 0;

		access.positionHardwareCursor({ row: 5, col: 3 }, 10);

		assert.strictEqual(access.hardwareCursorRow, 5, "hidden cursor must still be positioned for IME");
		assert.ok(terminal.writes.join("").includes("\x1b[5B"), "must move the cursor down");
		assert.ok(terminal.writes.join("").includes("\x1b[4G"), "must move the cursor column");
	});

	it("repaints from the viewport top instead of clearing scrollback for live changes above it", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const committed = new LinesComponent(Array.from({ length: 20 }, (_, index) => `c${index}`));
		const live = new LinesComponent(Array.from({ length: 20 }, (_, index) => `l${index}`));
		tui.setCommittedComponent(committed);
		tui.addChild(live);
		tui.renderNow();
		await terminal.flush();

		const redraws = tui.fullRedraws;
		// Change a live line that sits above the visible viewport (absolute row 25 of 40).
		live.lines = live.lines.map((line, index) => (index === 5 ? "l5-changed" : line));
		tui.renderNow();
		await terminal.flush();

		assert.strictEqual(tui.fullRedraws, redraws, "live reflow above the viewport must not clear scrollback");
		assert.ok(
			terminal.getViewport().some((line) => line.includes("l19")),
			"bottom of the live transcript stays visible",
		);
	});

	it("repaints from the viewport top when a change above it only restyles the transcript", async () => {
		const styled = (palette: number): string[] =>
			Array.from({ length: 20 }, (_, index) => `\x1b[48;5;${palette}ml${index}         \x1b[49m`);
		const terminal = new CapturingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		tui.setCommittedComponent(new LinesComponent(Array.from({ length: 20 }, (_, index) => `c${index}`)));
		const live = new LinesComponent(styled(236));
		tui.addChild(live);
		tui.renderNow();
		await terminal.flush();

		const redraws = tui.fullRedraws;
		// A finished tool block repaints every row it covers. Only the visible rows follow; the
		// scrollback above keeps the style it was written with instead of replaying the transcript.
		live.lines = styled(22);
		tui.renderNow();
		await terminal.flush();

		assert.strictEqual(tui.fullRedraws, redraws, "no scrollback replay for restyled rows");
		assert.ok(
			terminal.getViewport().some((line) => line.includes("l19")),
			"the transcript end stays visible",
		);
	});

	it("keeps the scrollback and repaints the last screenful when the content end goes above the viewport", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		tui.setCommittedComponent(new LinesComponent(Array.from({ length: 20 }, (_, index) => `c${index}`)));
		const live = new LinesComponent(Array.from({ length: 20 }, (_, index) => `l${index}`));
		tui.addChild(live);
		tui.addChild(new LinesComponent(["editor", "footer"]));
		tui.renderNow();
		await terminal.flush();

		const redraws = tui.fullRedraws;
		// A tall block collapses: the rows above the viewport are gone and the terminal cannot scroll
		// back to them, so the last screenful is repainted over the cleared screen.
		live.lines = live.lines.slice(0, 3);
		tui.renderNow();
		await terminal.flush();

		assert.strictEqual(tui.fullRedraws, redraws, "the scrollback is kept");
		const viewport = terminal.getViewport().map((line) => line.trimEnd());
		assert.deepStrictEqual(viewport.slice(-3), ["l2", "editor", "footer"], "end of the transcript stays visible");
	});

	// A streamed table's column widths follow the rows received so far. Rows that already scrolled into
	// the scrollback cannot be rewritten, so the table stays undrawn until final and is laid out once.
	it("writes a streamed table once, aligned, after the stream ends", async () => {
		const terminal = new VirtualTerminal(60, 12);
		const tui = new TuiMainScreen(terminal);
		let streaming = true;
		const markdown = new Markdown("intro\n\n| a | b |\n| --- | --- |\n", 0, 0, defaultMarkdownTheme, undefined, {
			incremental: () => streaming,
		});
		tui.addChild(markdown);
		tui.renderNow();

		let source = "intro\n\n| a | b |\n| --- | --- |\n";
		for (let row = 0; row < 30; row++) {
			source += `| r${row} | ${"cell ".repeat(row % 4)}value |\n`;
			markdown.setText(source);
			tui.renderNow();
		}
		assert.ok(
			!(await terminal.flushAndGetViewport()).some((line) => line.includes("│")),
			"a growing table is not drawn yet",
		);

		// The stream ends without another setText(): the table becomes final and is written once.
		streaming = false;
		tui.renderNow();
		await terminal.flush();

		const table = terminal.getScrollBuffer().filter((line) => /[│┌├└]/.test(line));
		assert.strictEqual(table.filter((line) => line.includes("┌")).length, 1, "one table top border");
		const widths = new Set(table.map((line) => visibleWidth(line.trimEnd())));
		assert.deepStrictEqual([...widths], [visibleWidth(table[0]!.trimEnd())], "every row keeps the final widths");
		assert.ok(table.length > 12, "the table is taller than the viewport and still written whole");
		assert.ok(
			!terminal.getScrollBuffer().some((line) => /\| r\d+ \|/.test(line)),
			"no provisional source rows stay in the scrollback",
		);
	});
});
