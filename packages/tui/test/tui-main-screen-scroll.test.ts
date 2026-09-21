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
});
