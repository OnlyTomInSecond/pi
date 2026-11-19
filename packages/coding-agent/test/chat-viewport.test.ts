import { Container, getKeybindings, setKeybindings, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});

	test("shows the jump-to-end hint on its own row and jumps back on a click", async () => {
		initTheme("dark");
		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+j" }));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TuiAltScreen(terminal);
		const viewport = createChatViewport({
			document: new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Text("editor", 0, 0),
			footer: new Text("footer", 0, 0),
			scrollbar: "hidden",
		});
		tui.setLayoutRoot(viewport.root);
		tui.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getViewport().some((line) => line.includes("Jump to latest"))).toBe(false);

			terminal.sendInput("\x1b[<64;1;1M");
			await terminal.waitForRender();
			const scrolled = terminal.getViewport();
			// The hint takes a transcript row of its own; the line above it stays complete.
			expect(scrolled[2]?.trimEnd()).toBe("line 28");
			expect(scrolled[3]).toContain("↓ Jump to latest message · Ctrl+J");
			expect(scrolled[4]?.trimEnd()).toBe("editor");

			terminal.sendInput("\x1b[<0;20;4M");
			terminal.sendInput("\x1b[<0;20;4m");
			await terminal.waitForRender();
			const jumped = terminal.getViewport();
			expect(jumped[3]?.trimEnd()).toBe("line 30");
			expect(jumped.some((line) => line.includes("Jump to latest"))).toBe(false);
		} finally {
			tui.stop();
			setKeybindings(previousKeybindings);
		}
	});
});
