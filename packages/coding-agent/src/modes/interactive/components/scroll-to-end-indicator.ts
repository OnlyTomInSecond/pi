import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

/**
 * Fullscreen transcript hint that owns the row between the transcript and the input dock, so the
 * label never covers transcript text. Clicking it returns to the end of the transcript.
 */
export class ScrollToEndIndicator implements Component {
	private readonly jumpToEnd: () => void;

	constructor(jumpToEnd: () => void) {
		this.jumpToEnd = jumpToEnd;
	}

	render(width: number): readonly string[] {
		const shortcut = keyDisplayText("tui.altScreen.bottom");
		const label = truncateToWidth(` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `, width, "");
		const labelWidth = visibleWidth(label);
		if (labelWidth === 0) return [];
		const left = Math.floor((width - labelWidth) / 2);
		return [" ".repeat(left) + theme.bg("selectedBg", theme.fg("text", label))];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "press" || event.button !== "left") return undefined;
		this.jumpToEnd();
		return { handled: true };
	}

	invalidate(): void {}
}
