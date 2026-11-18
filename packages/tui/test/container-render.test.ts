import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, Container, rowAt, rowsHeight } from "../src/tui.ts";

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

	it("addresses child lines by row without flattening them", () => {
		const container = new Container();
		const first = new Lines(["a", "b"]);
		const second = new Lines(["c"]);
		container.addChild(first);
		container.addChild(second);

		const rows = container.renderRows(20);
		assert.strictEqual(rowsHeight(rows), 3);
		assert.deepStrictEqual(
			[0, 1, 2, 3].map((row) => rowAt(rows, row)),
			["a", "b", "c", undefined],
		);
		assert.strictEqual(container.renderRows(20), rows, "unchanged children keep the index");

		second.lines = ["c", "d"];
		const changed = container.renderRows(20);
		assert.notStrictEqual(changed, rows, "a changed child rebuilds the index");
		assert.strictEqual(rowsHeight(changed), 4);
		assert.strictEqual(rowAt(changed, 3), "d");
	});

	it("addresses a nested container by row instead of flattening it", () => {
		const inner = new Container();
		inner.addChild(new Lines(["a", "b"]));
		inner.addChild(new Lines(["c"]));
		const outer = new Container();
		outer.addChild(inner);
		outer.addChild(new Lines(["d"]));

		const rows = outer.renderRows(20);
		assert.deepStrictEqual(
			[0, 1, 2, 3, 4].map((row) => rowAt(rows, row)),
			["a", "b", "c", "d", undefined],
		);
		// `childHeights()` only exists after `render()`, so a nested container reached this way kept its own
		// row index instead of assembling and copying its lines.
		assert.strictEqual(
			inner.childHeights(20),
			undefined,
			"a row-addressed frame does not flatten the nested container",
		);
		assert.strictEqual(outer.renderRows(20), rows, "unchanged children keep the index");
		assert.deepStrictEqual(outer.render(20), ["a", "b", "c", "d"], "the flat frame still renders");
	});

	it("answers with its own output when a subclass renders it", () => {
		class Overridden extends Container {
			override render(): readonly string[] {
				return ["custom"];
			}
		}
		const container = new Overridden();
		container.addChild(new Lines(["child"]));
		assert.deepStrictEqual(container.renderRows(20), ["custom"]);
	});
});
