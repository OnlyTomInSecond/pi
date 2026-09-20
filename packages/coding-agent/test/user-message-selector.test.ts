import { describe, expect, test, vi } from "vitest";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";

vi.mock("../src/modes/interactive/theme/theme.ts", () => ({
	initTheme: () => {},
	theme: {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	},
}));

function renderHeight(terminalHeight: number | undefined, messageCount: number): number {
	const messages = Array.from({ length: messageCount }, (_, index) => ({
		id: `entry-${index}`,
		text: `message ${index}`,
	}));
	const selector = new UserMessageSelectorComponent(
		messages,
		() => {},
		() => {},
		undefined,
		terminalHeight,
	);
	return selector.render(80).length;
}

describe("UserMessageSelectorComponent", () => {
	test("bounds the fork menu to the terminal height", () => {
		// 20 messages render 3 lines each, which previously pushed the fullscreen
		// status bar and footer off screen on a 24-row terminal.
		const bounded = renderHeight(24, 20);
		const unbounded = renderHeight(undefined, 20);

		expect(unbounded).toBeGreaterThan(24);
		expect(bounded).toBeLessThanOrEqual(24 - 4);
	});

	test("shows more messages as the terminal grows", () => {
		expect(renderHeight(80, 20)).toBeGreaterThan(renderHeight(24, 20));
	});
});
