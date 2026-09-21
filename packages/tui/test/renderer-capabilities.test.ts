import assert from "node:assert";
import { describe, it } from "node:test";
import { isCommittedTUI, isViewportTUI } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("renderer capability tags", () => {
	it("exposes the committed capability only on the main-screen renderer", () => {
		const main = new TuiMainScreen(new VirtualTerminal(40, 10));
		const alt = new TuiAltScreen(new VirtualTerminal(40, 10));

		assert.strictEqual(isCommittedTUI(main), true);
		assert.strictEqual(isCommittedTUI(alt), false);
	});

	it("exposes the viewport capability only on the alternate-screen renderer", () => {
		const main = new TuiMainScreen(new VirtualTerminal(40, 10));
		const alt = new TuiAltScreen(new VirtualTerminal(40, 10));

		assert.strictEqual(isViewportTUI(alt), true);
		assert.strictEqual(isViewportTUI(main), false);
	});
});
