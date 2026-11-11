import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, Container } from "../src/tui.ts";

class Lines implements Component {
	lines: string[];
	renders = 0;
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		this.renders += 1;
		return this.lines;
	}
	invalidate(): void {}
}

describe("Container render reuse", () => {
	it("reuses the assembled frame while children return the same lines", () => {
		const container = new Container();
		const first = new Lines(["a", "b"]);
		const second = new Lines(["c"]);
		container.addChild(first);
		container.addChild(second);

		const frame = container.render(20);
		assert.deepStrictEqual(frame, ["a", "b", "c"]);
		assert.strictEqual(container.render(20), frame, "unchanged frame is the same array");
		assert.deepStrictEqual(container.childHeights(20), [2, 1]);

		second.lines = ["c", "d"];
		assert.deepStrictEqual(container.render(20), ["a", "b", "c", "d"], "changed child rebuilds the frame");
		assert.strictEqual(container.childHeights(21), undefined, "a different width has no heights");
	});

	it("drops the frame when children are added or the width changes", () => {
		const container = new Container();
		const child = new Lines(["a"]);
		container.addChild(child);
		const frame = container.render(20);
		container.addChild(new Lines(["b"]));
		assert.deepStrictEqual(container.render(20), ["a", "b"]);
		assert.notStrictEqual(container.render(20), frame);
		assert.deepStrictEqual(container.render(10), ["a", "b"], "width change rebuilds");
	});
});
