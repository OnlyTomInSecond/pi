import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
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

	takeWrites(): string {
		const written = this.writes.join("");
		this.writes.length = 0;
		return written;
	}
}

const strip = (line: string) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\s+$/, "");

function renderLines(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `row-${String(index).padStart(2, "0")}`);
}

/** Reflow: a block loses or gains rows while a line above the end also changes. */
function renderReflowed(count: number, revision: number): string[] {
	const lines = renderLines(count);
	lines[4] = `row-04-r${revision}`;
	return lines;
}

/** The rows the renderer model says are on screen. */
function modelScreen(tui: TuiMainScreen, rows: number): string[] {
	const state = tui.captureRenderState();
	const screen = state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + rows).map(strip);
	while (screen.length < rows) screen.push("");
	return screen;
}

async function assertScreenMatchesModel(tui: TuiMainScreen, terminal: VirtualTerminal, context: string): Promise<void> {
	const actual = (await terminal.flushAndGetViewport()).map(strip);
	assert.deepStrictEqual(actual, modelScreen(tui, terminal.rows), context);
}

describe("TuiMainScreen deleted lines", () => {
	it("keeps the screen aligned when streamed content shrinks at the bottom", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		const live = new LinesComponent(renderLines(10));
		tui.addChild(live);
		tui.renderNow();
		await assertScreenMatchesModel(tui, terminal, "initial render");

		// A reflowing block (a streamed table whose cells re-wrap) loses and regains rows while the
		// last row stays on the final screen row. Clearing removed rows must not scroll the terminal,
		// which would shift the screen against the renderer model.
		for (const [revision, count] of [9, 10, 9, 8, 9, 7].entries()) {
			live.lines = renderReflowed(count, revision);
			tui.renderNow();
			await assertScreenMatchesModel(tui, terminal, `after reflowing to ${count} lines`);
		}
	});

	it("clears removed rows without scrolling the terminal", async () => {
		const terminal = new CapturingTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		const live = new LinesComponent(renderLines(10));
		tui.addChild(live);
		tui.renderNow();
		await terminal.flush();
		terminal.takeWrites();

		// One row above the end changes while the trailing row is removed, so the frame renders
		// changed lines and then deletes the last one.
		live.lines = renderReflowed(9, 1);
		tui.renderNow();
		await terminal.flush();

		const written = terminal.takeWrites();
		await assertScreenMatchesModel(tui, terminal, "after shrinking one row");
		assert.deepStrictEqual(
			(await terminal.flushAndGetViewport()).map(strip).slice(-1),
			[""],
			"the row that held the removed line is cleared",
		);
		assert.ok(written.length > 0, "the frame still writes");
	});

	it("truncating the transcript stays incremental and keeps the remaining rows", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		const live = new LinesComponent(renderLines(12));
		tui.addChild(live);
		tui.renderNow();
		await terminal.flush();
		const fullRedraws = tui.fullRedraws;

		// The new content ends on the last screen row, so every removed row is still visible.
		live.lines = renderLines(7);
		tui.renderNow();
		await assertScreenMatchesModel(tui, terminal, "after truncation");

		assert.strictEqual(tui.fullRedraws, fullRedraws, "truncation must not clear the scrollback");
		assert.deepStrictEqual(
			(await terminal.flushAndGetViewport()).map(strip).slice(0, 1),
			["row-06"],
			"the remaining content stays on screen",
		);
	});
});
