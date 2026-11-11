import { type Component, dispatchMouseEvent, type TuiMouseDispatchResult, type TuiMouseEvent } from "../tui.ts";
import { flattenLines, visibleWidth } from "../utils.ts";

type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	/** Rendered height of every child in this render. */
	heights: number[];
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	// Cache for rendered output
	private cache?: RenderCache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const contentWidth = Math.max(1, event.width - this.paddingX * 2);
		const contentY = event.y - this.paddingY;
		const contentX = event.x - this.paddingX;
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		const cachedHeights = this.cache?.width === contentWidth ? this.cache.heights : undefined;
		let childY = 0;
		for (let index = 0; index < this.children.length; index++) {
			const child = this.children[index]!;
			const childHeight = cachedHeights?.[index] ?? child.render(contentWidth).length;
			if (contentY >= childY && contentY < childY + childHeight) {
				return dispatchMouseEvent(child, {
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height: childHeight,
				});
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Render all children. Keep the child lines unpadded: children usually return the same string
		// objects every frame, so the cache check below is a cheap identity comparison per line.
		// Padding here would create new strings that must be compared character by character.
		const childLines: string[] = [];
		const heights: number[] = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			heights.push(lines.length);
			for (const line of lines) {
				childLines.push(line);
			}
		}

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Check cache validity
		if (this.matchCache(width, childLines, bgSample)) {
			return this.cache!.lines;
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.applyBg(leftPad + line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Update cache
		flattenLines(result);
		this.cache = { childLines, width, bgSample, heights, lines: result };

		return result;
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);
		// Already padded to width, so apply the background directly instead of measuring the line again.
		return this.bgFn ? this.bgFn(padded) : padded;
	}
}
