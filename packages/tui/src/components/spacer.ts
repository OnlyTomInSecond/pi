import type { Component } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	/**
	 * Last empty lines, returned again unchanged. Renderers reuse a container's frame while its children
	 * return the same array, and spacers sit in most message components.
	 */
	private last?: string[];

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
	}

	invalidate(): void {
		this.last = undefined;
	}

	render(_width: number): string[] {
		if (this.last?.length !== this.lines) this.last = new Array<string>(this.lines).fill("");
		return this.last;
	}
}
