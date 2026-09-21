import type { ScrollView } from "./components/scroll-view.ts";
import { getScrollViewBox, getScrollViewsAt, type LayoutFrame } from "./layout.ts";
import { isImageLine } from "./terminal-image.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "./utils.ts";

/** A selection endpoint in document (content) coordinates, optionally scoped to a scroll view. */
export interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
	/** Whether this point lies between terminal cells rather than on a cell. */
	boundary?: boolean;
}

export interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

export type SelectionGranularity = "character" | "word" | "line";

export interface SelectionMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

const DOUBLE_CLICK_INTERVAL_MS = 500;
const COPY_ERROR_FLASH_DURATION_MS = 5000;

/** Regular mode delegates double-click selection to the terminal; fullscreen keeps paths and kebab-case tokens whole. */
const TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-"]);
const wordSegmenter = getWordSegmenter();

/** Expand a point to the word (or joined path/kebab token) containing it. */
export function getWordSelection(line: string, point: SelectionPoint): SelectionRange | undefined {
	const text = stripTerminalSequences(line);
	const segments: Array<{ start: number; end: number; selectable: boolean; joiner: boolean }> = [];
	let start = 0;
	for (const segment of wordSegmenter.segment(text)) {
		const end = start + visibleWidth(segment.segment);
		const joiner = TERMINAL_WORD_SELECTION_JOINERS.has(segment.segment);
		segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
		start = end;
	}
	const clickedSegmentIndex = segments.findIndex((segment) => point.col >= segment.start && point.col < segment.end);
	if (clickedSegmentIndex < 0) return undefined;

	const canJoin = (
		left: { selectable: boolean; joiner: boolean },
		right: { selectable: boolean; joiner: boolean },
	): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
	let selectionStart = segments[clickedSegmentIndex].start;
	let selectionEnd = segments[clickedSegmentIndex].end;
	for (let index = clickedSegmentIndex; index > 0 && canJoin(segments[index - 1], segments[index]); index--) {
		selectionStart = segments[index - 1].start;
	}
	for (
		let index = clickedSegmentIndex;
		index < segments.length - 1 && canJoin(segments[index], segments[index + 1]);
		index++
	) {
		selectionEnd = segments[index + 1].end;
	}
	return {
		start: { ...point, col: selectionStart },
		end: { ...point, col: selectionEnd, boundary: true },
	};
}

/** Select the entire source line containing the point. */
export function getLineSelection(line: string, point: SelectionPoint): SelectionRange {
	return {
		start: { ...point, col: 0 },
		end: { ...point, col: visibleWidth(line), boundary: true },
	};
}

/** Normalize anchor/focus into an ordered, same-scroll-view range, or undefined when empty. */
export function getSelectionBounds(
	anchor: SelectionPoint | undefined,
	focus: SelectionPoint | undefined,
): { start: SelectionPoint; end: SelectionPoint } | undefined {
	if (!anchor || !focus) return undefined;
	if (anchor.scrollView !== focus.scrollView) return undefined;
	if (anchor.row === focus.row && anchor.col === focus.col) return undefined;
	const anchorBeforeFocus = anchor.row < focus.row || (anchor.row === focus.row && anchor.col < focus.col);
	return anchorBeforeFocus ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/** Resolve the cell range to highlight on one row, snapping to grapheme boundaries. */
export function getSelectionColumns(
	line: string,
	row: number,
	selection: { start: SelectionPoint; end: SelectionPoint },
	minColumn = 0,
	maxColumn = visibleWidth(line),
): { start: number; end: number } {
	const lineWidth = visibleWidth(line);
	let start = Math.max(0, minColumn);
	let end = Math.min(lineWidth, maxColumn);
	if (row === selection.start.row) {
		start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
	}
	if (row === selection.end.row) {
		end = selection.end.boundary
			? Math.min(selection.end.col, lineWidth)
			: (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
	}
	return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
}

/** Apply reverse-video to text while preserving embedded ANSI codes. */
export function applySelectionHighlight(text: string): string {
	let result = "\x1b[7m";
	let index = 0;
	while (index < text.length) {
		const ansi = extractAnsiCode(text, index);
		if (!ansi) {
			result += text[index];
			index += 1;
			continue;
		}
		result += ansi.code;
		if (ansi.code.endsWith("m")) result += "\x1b[7m";
		index += ansi.length;
	}
	return `${result}\x1b[27m`;
}

interface ClickTarget {
	timestamp: number;
	count: number;
	row: number;
	scrollView?: ScrollView;
	wordStart: number;
	wordEnd: number;
}

/** Renderer access needed by {@link AltScreenSelection}. Kept narrow so the renderer owns layout and output. */
export interface SelectionHost {
	getRows(): number;
	getColumns(): number;
	getLayout(): LayoutFrame | undefined;
	getScreen(): readonly string[];
	write(data: string): void;
	requestRender(): void;
	hasOverlay(): boolean;
	flash(message: string, durationMs?: number): void;
	/** Dispatch a completed click to overlays/components; returns whether the click was handled and needs repaint. */
	tryDispatchClick(button: number, x: number, y: number, clickCount: number): { render: boolean } | undefined;
	openUrl?(url: string): void;
	copySelection?(text: string): Promise<boolean | string>;
}

/**
 * Owns fullscreen mouse text selection: press/drag/release, word/line granularity, edge auto-scroll,
 * OSC 8 link activation, and clipboard copy. The renderer forwards events and asks for the highlight overlay.
 */
export class AltScreenSelection {
	private readonly host: SelectionHost;
	private copyOnSelect: boolean;
	private selectionAnchor?: SelectionPoint;
	private selectionFocus?: SelectionPoint;
	private selectionGranularity: SelectionGranularity = "character";
	private selectionInitialRange?: SelectionRange;
	private lastClick?: ClickTarget;
	private selectionDragPointer?: { x: number; y: number };
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	private selectionPressActive = false;
	private pressedUrl?: string;
	private selectionDragged = false;

	constructor(host: SelectionHost, copyOnSelect = true) {
		this.host = host;
		this.copyOnSelect = copyOnSelect;
	}

	getCopyOnSelect(): boolean {
		return this.copyOnSelect;
	}

	setCopyOnSelect(enabled: boolean): void {
		this.copyOnSelect = enabled;
	}

	hasActiveSelection(): boolean {
		return this.getActiveSelectionText() !== undefined;
	}

	async copyActiveSelectionToClipboard(): Promise<boolean> {
		const text = this.getActiveSelectionText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	/** Clear selection state and click history. */
	reset(): void {
		this.clear();
		this.lastClick = undefined;
	}

	/** Clear the active selection without forgetting click history. */
	clear(): void {
		this.stopAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
	}

	/** Drop an in-progress press (terminal blur/stop) and stop auto-scroll. */
	cancelPress(): void {
		this.selectionPressActive = false;
		this.stopAutoScroll();
	}

	/** Handle focus loss: reset an in-progress selection, returning whether a visible selection was cleared. */
	handleFocusOut(): boolean {
		const hadActiveSelection = this.selectionPressActive;
		const hadNonEmptyActiveSelection =
			hadActiveSelection && getSelectionBounds(this.selectionAnchor, this.selectionFocus) !== undefined;
		this.selectionPressActive = false;
		this.stopAutoScroll();
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		if (hadActiveSelection) {
			this.selectionAnchor = undefined;
			this.selectionFocus = undefined;
			this.selectionGranularity = "character";
			this.selectionInitialRange = undefined;
		}
		this.lastClick = undefined;
		return hadNonEmptyActiveSelection;
	}

	handleMouseEvent(event: SelectionMouseEvent): void {
		const button = event.button & 3;
		if (button !== 0 && !(event.release && button === 3)) return;
		const anchorScrollView = this.selectionAnchor?.scrollView;
		const point = this.getSelectionPoint(event, anchorScrollView);
		if (event.release) {
			if (!this.selectionPressActive) return;
			this.selectionPressActive = false;
			this.stopAutoScroll();
			if (!this.selectionAnchor) return;
			this.updateSelectionFocus(point);
			const isClick =
				!this.selectionDragged &&
				this.selectionAnchor.scrollView === point.scrollView &&
				this.selectionAnchor.row === point.row &&
				this.selectionAnchor.col === point.col;
			const clickedUrl = isClick ? this.pressedUrl : undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.host.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.host.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.host.requestRender();
				return;
			}
			if (isClick) {
				const clicked = this.host.tryDispatchClick(event.button, event.x, event.y, this.lastClick?.count ?? 1);
				if (clicked) {
					this.clear();
					if (clicked.render) this.host.requestRender();
					return;
				}
			}
			if (this.copyOnSelect) void this.copySelectionToClipboard();
			this.host.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			this.selectionDragged = true;
			this.lastClick = undefined;
			this.pressedUrl = undefined;
			this.updateSelectionFocus(point);
			this.updateAutoScroll(event);
			this.host.requestRender();
			return;
		}
		this.stopAutoScroll();
		this.selectionPressActive = true;
		const layout = this.host.getLayout();
		const scrollView = !this.host.hasOverlay() && layout ? getScrollViewsAt(layout, event.x, event.y)[0] : undefined;
		const anchor = this.getSelectionPoint(event, scrollView);
		const word = getWordSelection(this.getSelectionSourceLine(anchor), anchor);
		const clickCount = this.getClickCount(anchor, word);
		const range =
			clickCount === 2
				? word
				: clickCount === 3
					? getLineSelection(this.getSelectionSourceLine(anchor), anchor)
					: undefined;
		this.selectionGranularity = range ? (clickCount === 2 ? "word" : "line") : "character";
		this.selectionInitialRange = range;
		this.selectionAnchor = range?.start ?? anchor;
		this.selectionFocus = range?.end ?? anchor;
		this.selectionDragged = false;
		this.pressedUrl = range
			? undefined
			: getOsc8LinkAtColumn(
					this.host.getScreen()[Math.max(0, Math.min(this.host.getRows() - 1, event.y))] ?? "",
					Math.max(0, Math.min(this.host.getColumns() - 1, event.x)),
				);
		this.host.requestRender();
	}

	/** Composite the reverse-video highlight for the active selection onto a rendered screen. */
	apply(screen: string[], layout: LayoutFrame | undefined): string[] {
		const selection = getSelectionBounds(this.selectionAnchor, this.selectionFocus);
		if (!selection) return screen;
		let screenSelection = selection;
		let minRow = 0;
		let maxRow = screen.length - 1;
		let minColumn = 0;
		let maxColumn = this.host.getColumns();
		if (selection.start.scrollView) {
			if (!layout) return screen;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box) return screen;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			maxColumn = Math.min(this.host.getColumns(), box.rect.x + box.rect.width, box.clip.x + box.clip.width);
			screenSelection = {
				start: {
					...selection.start,
					row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.start.col,
				},
				end: {
					...selection.end,
					row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.end.col,
				},
			};
		}
		return screen.map((line, row) => {
			if (
				row < minRow ||
				row > maxRow ||
				row < screenSelection.start.row ||
				row > screenSelection.end.row ||
				isImageLine(line)
			) {
				return line;
			}
			const lineWidth = visibleWidth(line);
			const columns = getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
			if (columns.end <= columns.start) return line;
			const before = sliceByColumn(line, 0, columns.start, true);
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
			const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
			return `${before}${applySelectionHighlight(selected)}${after}`;
		});
	}

	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		const layout = this.host.getLayout();
		if (!layout) return undefined;
		const box = getScrollViewBox(layout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.host.getRows() - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		return {
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		};
	}

	private getSelectionPoint(event: SelectionMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		return {
			row: Math.max(0, Math.min(this.host.getRows() - 1, event.y)),
			col: Math.max(0, Math.min(this.host.getColumns() - 1, event.x)),
		};
	}

	private getSelectionSourceLine(point: SelectionPoint): string {
		const layout = this.host.getLayout();
		if (point.scrollView && layout) {
			const lines = getScrollViewBox(layout, point.scrollView)?.scrollContentLines;
			if (lines) return lines[point.row] ?? "";
		}
		return this.host.getScreen()[point.row] ?? "";
	}

	private updateSelectionFocus(point: SelectionPoint): void {
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			this.selectionFocus = point;
			return;
		}
		const sourceLine = this.getSelectionSourceLine(point);
		const range =
			this.selectionGranularity === "word"
				? getWordSelection(sourceLine, point)
				: getLineSelection(sourceLine, point);
		if (!range) return;
		const initial = this.selectionInitialRange;
		const targetBeforeInitial =
			range.start.row < initial.start.row ||
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		if (targetBeforeInitial) {
			this.selectionAnchor = initial.end;
			this.selectionFocus = range.start;
		} else {
			this.selectionAnchor = initial.start;
			this.selectionFocus = range.end;
		}
	}

	private getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.row === point.row &&
			previous.scrollView === point.scrollView &&
			previous.wordStart === word.start.col &&
			previous.wordEnd === word.end.col
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? {
					timestamp: now,
					count,
					row: point.row,
					scrollView: point.scrollView,
					wordStart: word.start.col,
					wordEnd: word.end.col,
				}
			: undefined;
		return count;
	}

	private updateAutoScroll(event: SelectionMouseEvent): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const layout = this.host.getLayout();
		if (!scrollView || !layout) {
			this.stopAutoScroll();
			return;
		}
		const box = getScrollViewBox(layout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.host.getRows() - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.selectionDragPointer = { x: event.x, y: event.y };
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (this.selectionAutoScrollDirection === 0) {
			this.stopAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScroll(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	private autoScroll(): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopAutoScroll();
			return;
		}
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		if (point) this.updateSelectionFocus(point);
		this.host.requestRender();
	}

	private stopAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	private getActiveSelectionText(): string | undefined {
		const selection = getSelectionBounds(this.selectionAnchor, this.selectionFocus);
		if (!selection) return undefined;
		let sourceLines: readonly string[] = this.host.getScreen();
		if (selection.start.scrollView) {
			const layout = this.host.getLayout();
			if (!layout) return undefined;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box?.scrollContentLines) return undefined;
			sourceLines = box.scrollContentLines;
		}
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = sourceLines[row] ?? "";
			const columns = getSelectionColumns(line, row, selection);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
				).trimEnd(),
			);
		}
		const text = lines.join("\n");
		return text.length === 0 ? undefined : text;
	}

	private async copySelectionToClipboard(): Promise<boolean> {
		const text = this.getActiveSelectionText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	private async copyTextToClipboard(text: string): Promise<boolean> {
		// Prefer an injected clipboard implementation (native clipboard + platform tools with a
		// verified success path) when the host app provides one. A bare OSC 52 write can show
		// "Copied!" while leaving the system clipboard untouched (e.g. macOS Terminal.app, tmux
		// without OSC 52 clipboard passthrough), so only report success when it actually copies.
		if (this.host.copySelection) {
			const result = await this.host.copySelection(text);
			const ok = result === true;
			this.host.flash(
				ok ? "Copied!" : typeof result === "string" ? result : "Copy failed",
				ok ? undefined : COPY_ERROR_FLASH_DURATION_MS,
			);
			return ok;
		}
		this.host.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.host.flash("Copied!");
		return true;
	}
}
