import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class LinesComponent implements Component {
	renderCount = 0;
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		this.renderCount += 1;
		return this.lines;
	}

	invalidate(): void {}
}

describe("TuiMainScreen committed prefix", () => {
	it("re-renders only the live tail on steady frames", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const committed = new LinesComponent(["c1", "c2", "c3"]);
		const live = new LinesComponent(["l1"]);
		tui.setCommittedComponent(committed);
		tui.addChild(live);

		tui.renderNow();
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).slice(0, 4), ["c1", "c2", "c3", "l1"]);
		assert.strictEqual(committed.renderCount, 1);

		live.lines = ["l1", "l2"];
		tui.renderNow();
		assert.strictEqual(committed.renderCount, 1, "committed prefix must not re-render per frame");
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).slice(0, 5), ["c1", "c2", "c3", "l1", "l2"]);

		live.lines = ["l1", "l2", "l3"];
		tui.renderNow();
		assert.strictEqual(committed.renderCount, 1);
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).slice(0, 6), ["c1", "c2", "c3", "l1", "l2", "l3"]);
	});

	it("re-renders the committed prefix after invalidation", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const committed = new LinesComponent(["c1"]);
		tui.setCommittedComponent(committed);
		tui.renderNow();
		assert.strictEqual(committed.renderCount, 1);

		committed.lines = ["c1", "c2"];
		tui.invalidateCommitted();
		tui.renderNow();
		assert.strictEqual(committed.renderCount, 2);
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).slice(0, 2), ["c1", "c2"]);
	});

	it("re-renders the committed prefix on width change", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const committed = new LinesComponent(["c1"]);
		tui.setCommittedComponent(committed);
		tui.renderNow();
		await terminal.flush();
		assert.strictEqual(committed.renderCount, 1);

		terminal.resize(20, 10);
		tui.renderNow();
		await terminal.flush();
		assert.strictEqual(committed.renderCount, 2);
	});

	it("updates the committed prefix when live content is replaced", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const committed = new LinesComponent(["c1", "c2"]);
		const live = new LinesComponent(["l1", "l2"]);
		tui.setCommittedComponent(committed);
		tui.addChild(live);
		tui.renderNow();
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).slice(0, 4), ["c1", "c2", "l1", "l2"]);

		// Simulate the coding agent promoting the finalized tail into the committed prefix.
		committed.lines = ["c1", "c2", "l1", "l2"];
		live.lines = ["l3"];
		tui.invalidateCommitted();
		tui.renderNow();
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).slice(0, 5), ["c1", "c2", "l1", "l2", "l3"]);
		assert.strictEqual(committed.renderCount, 2);
	});
});
