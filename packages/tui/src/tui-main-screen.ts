import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BoundedTerminalWriter } from "./output-writer.ts";
import { deleteKittyImage, getMaxKittyImageRows, isImageLine } from "./terminal-image.ts";
import {
	COMMITTED_TUI,
	type CommittedTUI,
	type Component,
	Container,
	TuiBase,
	type TuiMainScreenRenderState,
	type TuiStopOptions,
} from "./tui.ts";
import { visibleWidth } from "./utils.ts";

/** OSC 133 prompt markers at the start of a rendered line. Fullscreen uses them for prompt navigation. */
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/** Drop OSC 133 prompt markers: the terminal reads 133;A as a new shell prompt, which ends program status (OSC 7501). */
function stripOsc133(lines: string[]): string[] {
	return lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
}

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements CommittedTUI {
	readonly mode = "regular" as const;
	readonly [COMMITTED_TUI] = true as const;
	private previousLines: string[] = [];
	private previousCommittedCount = 0;
	private previousKittyImageIds = new Set<number>();
	private committedComponent: Component | undefined;
	private committedLines: string[] = [];
	private committedWidth = -1;
	private committedDirty = true;
	private committedJustRendered = false;
	/** Committed component children already rendered into {@link committedLines}. */
	private committedChildCount = 0;
	/** Children were appended to the committed component and can be rendered incrementally. */
	private committedAppendPending = false;
	/** Rendered lines of each committed child, in order, matching {@link committedLines}. */
	private committedChildHeights: number[] = [];
	/** Leading committed children whose render caches were dropped. */
	private releasedCommittedChildren = 0;
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private hardwareCursorCol = -1;
	private hardwareCursorVisible: boolean | undefined;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;

	/**
	 * Set the component whose rendered lines form the committed (immutable) transcript prefix.
	 * The renderer caches its output per width and only re-renders it when the width changes or
	 * {@link invalidateCommitted} is called.
	 */
	setCommittedComponent(component: Component | undefined): void {
		this.committedComponent = component;
		this.committedLines = [];
		this.committedWidth = -1;
		this.committedDirty = true;
		this.committedChildCount = 0;
		this.committedAppendPending = false;
		this.resetCommittedChildHeights([]);
		this.requestRender();
	}

	/** Mark the committed prefix dirty so it is re-rendered on the next frame. */
	invalidateCommitted(): void {
		this.committedDirty = true;
		this.committedAppendPending = false;
		this.requestRender();
	}

	/**
	 * Mark that children were appended to the committed component since the last frame. The added
	 * children are rendered and appended to the cached prefix instead of re-rendering all of it.
	 */
	appendCommitted(): void {
		if (this.committedComponent instanceof Container) {
			this.committedAppendPending = true;
		} else {
			this.committedDirty = true;
		}
		this.requestRender();
	}

	override invalidate(): void {
		super.invalidate();
		this.committedDirty = true;
	}

	private renderCommitted(width: number): string[] {
		this.committedJustRendered = false;
		if (!this.committedComponent) {
			this.committedLines = [];
			this.committedWidth = width;
			this.committedChildCount = 0;
			this.committedAppendPending = false;
			this.resetCommittedChildHeights([]);
			return this.committedLines;
		}
		if (this.committedDirty || this.committedWidth !== width) {
			this.committedLines = stripOsc133(this.resolveFakeCursors(this.committedComponent.render(width)));
			this.committedWidth = width;
			this.committedDirty = false;
			this.committedAppendPending = false;
			this.committedJustRendered = true;
			this.committedChildCount =
				this.committedComponent instanceof Container ? this.committedComponent.children.length : 0;
			this.resetCommittedChildHeights(
				this.committedComponent instanceof Container ? (this.committedComponent.childHeights(width) ?? []) : [],
			);
			return this.committedLines;
		}
		if (this.committedAppendPending) {
			this.committedAppendPending = false;
			// appendCommitted() only sets this flag when the committed component is a Container.
			const committed = this.committedComponent as Container;
			const appendedHeights: number[] = [];
			for (let i = this.committedChildCount; i < committed.children.length; i++) {
				const lines = stripOsc133(this.resolveFakeCursors(committed.children[i]!.render(width)));
				appendedHeights.push(lines.length);
				for (const line of lines) {
					this.committedLines.push(line);
				}
			}
			this.appendCommittedChildHeights(appendedHeights);
			this.committedChildCount = committed.children.length;
		}
		return this.committedLines;
	}

	/** Replace the per-child line counts after a full render. */
	private resetCommittedChildHeights(heights: number[]): void {
		this.committedChildHeights = heights;
		this.releasedCommittedChildren = 0;
	}

	private appendCommittedChildHeights(heights: number[]): void {
		for (const height of heights) this.committedChildHeights.push(height);
	}

	/**
	 * Drop the render caches of committed transcript children the terminal can no longer repaint.
	 *
	 * The renderer rewrites lines up to the viewport top, so older rows only change again on a full
	 * redraw, and a full redraw re-renders the committed component from source anyway (see
	 * renderCommitted()). Keeping those caches costs memory in two places: the rendered lines, and,
	 * for Markdown, the parse tree and per-token lines of every message in the session, which are
	 * about ten times the size of the message source. Released children keep rendering correctly and
	 * simply re-parse on the next full redraw.
	 */
	private releaseCommittedRenderCaches(): void {
		const committed = this.committedComponent;
		if (!(committed instanceof Container)) return;
		if (this.committedChildHeights.length !== committed.children.length) return;
		const repaintableFrom = Math.max(0, this.previousViewportTop);
		let offset = 0;
		let released = this.releasedCommittedChildren;
		for (let i = released; i < this.committedChildHeights.length; i++) {
			const end = offset + (this.committedChildHeights[i] ?? 0);
			if (end > repaintableFrom) break;
			committed.children[i]?.releaseRenderCache?.();
			released = i + 1;
			offset = end;
		}
		this.releasedCommittedChildren = released;
	}

	/**
	 * Store a rendered frame as the comparison baseline. When `rebuild` is true the flat
	 * `previousLines` array is recreated from `head`/`tail`, otherwise the committed prefix is
	 * retained in place and only the live tail is rewritten.
	 */
	private recordFrame(head: string[], tail: string[], rebuild: boolean): void {
		if (head.length === 0) {
			this.previousLines = tail;
			this.previousCommittedCount = 0;
			return;
		}
		if (rebuild) {
			this.previousLines = head.slice();
		} else {
			this.previousLines.length = head.length;
		}
		for (const line of tail) this.previousLines.push(line);
		this.previousCommittedCount = head.length;
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.committedComponent ? [...this.children, this.committedComponent] : this.children;
	}

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousCommittedCount = 0;
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.hardwareCursorCol = -1;
		this.hardwareCursorVisible = undefined;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousCommittedCount = 0;
		this.committedLines = [];
		this.committedWidth = -1;
		this.committedDirty = true;
		this.committedChildCount = 0;
		this.committedAppendPending = false;
		this.resetCommittedChildHeights([]);
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.hardwareCursorCol = -1;
		this.hardwareCursorVisible = undefined;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		this.hardwareCursorCol = -1;
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private rangeHasKittyImages(head: readonly string[], tail: readonly string[], from: number, to: number): boolean {
		const start = Math.max(0, from);
		const end = Math.min(to, head.length + tail.length - 1);
		for (let i = start; i <= end; i++) {
			const line = i < head.length ? (head[i] ?? "") : (tail[i - head.length] ?? "");
			if (extractKittyImageIds(line).length > 0) return true;
		}
		return false;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	protected doRender(): void {
		if (this.stopped) return;
		this.renderFrame();
		// Must run after the frame: it uses the committed boundary this frame established.
		this.releaseCommittedRenderCaches();
	}

	private renderFrame(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render the committed prefix (cached) and the live tail separately. Only the tail is
		// re-rendered every frame; the prefix is re-rendered on width change or invalidation.
		// Fake cursors are resolved and OSC 133 markers dropped before compositing so overlays and
		// line slicing see plain SGR codes, and so the terminal does not read a marker as a new
		// shell prompt, which would end program status (OSC 7501).
		let head = this.renderCommitted(width);
		const committedRefreshed = this.committedJustRendered;
		let tail = stripOsc133(this.resolveFakeCursors(this.render(width)));

		// Composite overlays into the rendered lines (before differential compare)
		if (this.hasOverlayEntries) {
			head = this.compositeOverlays(head.concat(tail), width, height);
			tail = [];
		}

		const lineAt = (index: number): string =>
			index < head.length ? (head[index] ?? "") : (tail[index - head.length] ?? "");
		let totalLines = head.length + tail.length;
		const materialize = (): string[] => (head.length === 0 ? tail.slice() : head.concat(tail));
		// The committed prefix is stable when it was not re-rendered and did not shrink. Overlay
		// compositing and kitty materialization replace `head` with a flat array, forcing a rebuild.
		const previousTotal = this.previousLines.length;
		// A committed prefix that only grew was appended to (see appendCommitted()), so the diff can
		// still start at the previous committed boundary instead of rebuilding the whole frame.
		let rebuild =
			committedRefreshed ||
			this.hasOverlayEntries ||
			head.length < this.previousCommittedCount ||
			head.length > previousTotal;

		// Extract cursor position before formatting line resets (marker must be found first)
		const cursorPos =
			tail.length > 0
				? (() => {
						const pos = this.extractCursorPosition(tail, height);
						return pos ? { row: pos.row + head.length, col: pos.col } : null;
					})()
				: this.extractCursorPosition(head, height);

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (mode: "first" | "all" | "window"): void => {
			// A window repaint keeps the scrollback, so it is not a full redraw.
			if (mode !== "window") this.fullRedrawCount += 1;
			// "window" keeps the scrollback and repaints only the last screenful, which is the cheap
			// repair when rows above the viewport changed or went away. It reads that window from the
			// frame directly instead of assembling every line.
			const firstRow = mode === "window" ? Math.max(0, totalLines - height) : 0;
			const renderLines =
				mode === "window"
					? Array.from({ length: totalLines - firstRow }, (_, offset) => lineAt(firstRow + offset))
					: materialize();
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			output.append("\x1b[?2026h"); // Begin synchronized output
			if (mode !== "first") {
				output.append(this.deleteKittyImages(this.previousKittyImageIds));
				output.append(mode === "window" ? "\x1b[2J\x1b[H" : "\x1b[2J\x1b[H\x1b[3J");
			}
			for (let i = 0; i < renderLines.length; i++) {
				if (i > 0) output.append("\r\n");
				const line = renderLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(renderLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						output.append("\r\n");
					}
					output.append(`\x1b[${imageReservedRows - 1}A`);
					output.append(line);
					output.append(`\x1b[${imageReservedRows - 1}B`);
					i += imageReservedRows - 1;
					continue;
				}
				output.append(this.formatOutputLine(line));
			}
			output.append("\x1b[?2026l"); // End synchronized output
			output.flush();
			this.cursorRow = Math.max(0, totalLines - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing the scrollback, otherwise track growth
			if (mode === "all") {
				this.maxLinesRendered = totalLines;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, totalLines);
			}
			const bufferLength = mode === "window" ? totalLines : Math.max(height, totalLines);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.hardwareCursorCol = -1;
			this.positionHardwareCursor(cursorPos, totalLines);
			this.recordFrame(head, tail, true);
			this.previousKittyImageIds = this.collectKittyImageIds(renderLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const redrawLogDirectory = process.env.PI_TUI_DEBUG_REDRAW === "1" ? this.logDirectory : undefined;
		const logRedraw = (reason: string): void => {
			if (redrawLogDirectory === undefined) return;
			const logPath = path.join(redrawLogDirectory, "pi-tui-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${totalLines}, height=${height})\n`;
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender("first");
			return;
		}

		// Width changes re-wrap every line. Repainting the last screenful keeps the scrollback (at the
		// old width) instead of rewriting the whole transcript, which is what floods a slow link. A
		// Kitty image that starts above the window is the exception: only a full replay can place it.
		const resizeRepaint = (reason: string): void => {
			logRedraw(reason);
			const windowStart = Math.max(0, totalLines - height);
			let imageAboveWindow = false;
			for (let i = Math.max(0, windowStart - getMaxKittyImageRows()); i < windowStart; i++) {
				if (isImageLine(lineAt(i))) {
					imageAboveWindow = true;
					break;
				}
			}
			fullRender(imageAboveWindow ? "all" : "window");
		};

		if (widthChanged) {
			resizeRepaint(`terminal width changed (${this.previousWidth} -> ${width})`);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			resizeRepaint(`terminal height changed (${this.previousHeight} -> ${height})`);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink()
		if (this.getClearOnShrink() && totalLines < this.maxLinesRendered && !this.hasOverlayEntries) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender("all");
			return;
		}

		// Find first and last changed lines. When the committed prefix is stable, only the live
		// tail can change, so the comparison starts at the committed boundary.
		const compareStart = rebuild ? 0 : this.previousCommittedCount;
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(totalLines, previousTotal);
		for (let i = compareStart; i < maxLines; i++) {
			const oldLine = i < previousTotal ? (this.previousLines[i] ?? "") : "";
			const newLine = i < totalLines ? lineAt(i) : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = totalLines > previousTotal;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = previousTotal;
			}
			lastChanged = totalLines - 1;
		}
		let newLines = head;
		let trackKittyImages = this.previousKittyImageIds.size > 0;
		if (firstChanged !== -1) {
			if (trackKittyImages || this.rangeHasKittyImages(head, tail, firstChanged, lastChanged)) {
				if (tail.length > 0) {
					head = materialize();
					tail = [];
					totalLines = head.length;
					newLines = head;
					rebuild = true;
				}
				const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
				firstChanged = expandedRange.firstChanged;
				lastChanged = expandedRange.lastChanged;
				trackKittyImages = true;
			}
		}
		const appendStart = appendedLines && firstChanged === previousTotal && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, totalLines);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			this.previousCommittedCount = head.length;
			return;
		}

		// Rows went away above the viewport (a tall block collapsed, a message lost its expanded rows) and
		// the terminal cannot scroll back to the content end. Clearing the leftover rows would leave the
		// screen blank below it, so repaint the last screenful over the cleared screen and keep the
		// scrollback as it was.
		const contentEndViewportTop = Math.max(0, totalLines - height);
		if (prevViewportTop > contentEndViewportTop) {
			logRedraw(`viewport below the content end (${prevViewportTop} > ${contentEndViewportTop})`);
			fullRender("window");
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= totalLines) {
			if (previousTotal > totalLines) {
				const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
				output.append("\x1b[?2026h");
				output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, totalLines - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender("window");
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
				else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
				output.append("\r");
				// Clear extra lines without scrolling
				const extraLines = previousTotal - totalLines;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender("window");
					return;
				}
				// Clear the deleted rows that are on screen, from the bottom up. Rows below the last
				// screen row are already invisible: moving down to them clamps on the last row and
				// clears live content, and scrolling to reach them desyncs the terminal from the
				// renderer model.
				const firstDeletedRow = totalLines;
				const lastDeletedRow = Math.min(previousTotal - 1, prevViewportTop + height - 1);
				if (lastDeletedRow >= firstDeletedRow) {
					const moveDown = lastDeletedRow - targetRow;
					if (moveDown > 0) output.append(`\x1b[${moveDown}B`);
					for (let row = lastDeletedRow; row >= firstDeletedRow; row--) {
						output.append("\r\x1b[2K");
						if (row > firstDeletedRow) output.append("\x1b[1A");
					}
					if (firstDeletedRow > targetRow) output.append("\x1b[1A");
				}
				output.append("\x1b[?2026l");
				output.flush();
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.hardwareCursorCol = -1;
			this.positionHardwareCursor(cursorPos, totalLines);
			this.recordFrame(head, tail, rebuild);
			if (trackKittyImages) this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			else this.previousKittyImageIds.clear();
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible. Committed-prefix
		// refreshes (theme, width, invalidation) and frames without a committed prefix still need a
		// full redraw when a change landed above the viewport.
		if (firstChanged < prevViewportTop) {
			// Rows above the viewport are in terminal scrollback and cannot be rewritten. Repaint from
			// the viewport top instead of clearing scrollback and replaying history, which would yank
			// the user back to the bottom while they read it. Scrollback keeps whatever it had: stale
			// styles after a theme change or a block that changed color, and stale rows after a reflow.
			firstChanged = Math.min(prevViewportTop, totalLines - 1);
		}

		// Render from first changed line to end
		// Keep updates wrapped in synchronized output while writing bounded chunks.
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h"); // Begin synchronized output
		output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				output.append(`\x1b[${moveToBottom}B`);
			}
			const scroll = moveTargetRow - prevViewportBottom;
			output.append("\r\n".repeat(scroll));
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			output.append(`\x1b[${lineDiff}B`); // Move down
		} else if (lineDiff < 0) {
			output.append(`\x1b[${-lineDiff}A`); // Move up
		}

		output.append(appendStart ? "\r\n" : "\r"); // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, totalLines - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) output.append("\r\n");
			const line = lineAt(i);
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender("all");
					return;
				}

				output.append("\x1b[2K");
				for (let row = 1; row < imageReservedRows; row++) {
					output.append("\r\n\x1b[2K");
				}
				output.append(`\x1b[${imageReservedRows - 1}A`);
				output.append(line);
				output.append(`\x1b[${imageReservedRows - 1}B`);
				i += imageReservedRows - 1;
				continue;
			}

			const outputLine = this.formatOutputLine(line);
			const outputWidth = isImage ? 0 : visibleWidth(outputLine);
			// A line that fills the terminal width overwrites the row completely, so erasing it first only
			// flashes the row. A streamed block above the editor shifts the editor and footer rows every
			// frame, and erasing them flickers the cursor and the IME candidate window.
			if (outputWidth < width) output.append("\x1b[2K");
			if (!isImage && outputWidth > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(this.logDirectory ?? os.tmpdir(), "pi-tui-crash.log");
				const crashLines = materialize();
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${outputWidth}`,
					"",
					"=== All rendered lines ===",
					...crashLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${outputWidth} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			output.append(outputLine);
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear the deleted rows and move the cursor back to the end of
		// the new content. Clearing must not write "\r\n" on the last screen row: that scrolls the
		// terminal, and the cursor-up that follows cannot undo the scroll, which leaves the screen
		// and the renderer model off by one row until a full redraw.
		if (previousTotal > totalLines) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < totalLines - 1) {
				const moveDown = totalLines - 1 - renderEnd;
				output.append(`\x1b[${moveDown}B`);
				finalCursorRow = totalLines - 1;
			}
			const firstDeletedRow = Math.max(totalLines, prevViewportTop);
			const lastDeletedRow = Math.min(previousTotal - 1, prevViewportTop + height - 1);
			if (lastDeletedRow >= firstDeletedRow) {
				const moveDown = lastDeletedRow - finalCursorRow;
				if (moveDown > 0) output.append(`\x1b[${moveDown}B`);
				for (let row = lastDeletedRow; row >= firstDeletedRow; row--) {
					output.append("\r\x1b[2K");
					if (row > firstDeletedRow) output.append("\x1b[1A");
				}
				const moveBack = firstDeletedRow - (totalLines - 1);
				if (moveBack > 0) output.append(`\x1b[${moveBack}A`);
			}
			finalCursorRow = Math.max(0, totalLines - 1);
		}

		output.append("\x1b[?2026l"); // End synchronized output

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugLines = materialize();
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${totalLines}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(debugLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				`[${output.length} chars written in bounded chunks]`,
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		output.flush();

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, totalLines - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, totalLines);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.hardwareCursorCol = -1;
		this.positionHardwareCursor(cursorPos, totalLines);

		this.recordFrame(head, tail, rebuild);
		if (trackKittyImages) this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		else this.previousKittyImageIds.clear();
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window. The cursor is positioned even when it is
	 * hidden: terminals such as Alacritty anchor the IME candidate window to the (invisible) hardware
	 * cursor position. `showHardwareCursor` only controls visibility, not whether we position it.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.setHardwareCursorVisible(false);
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target. Re-emitted moves and visibility toggles make the
		// cursor and the IME candidate window flicker on terminals that apply them one by one, so only
		// the parts that changed are written.
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		if (targetCol !== this.hardwareCursorCol) {
			buffer += `\x1b[${targetCol + 1}G`; // Move to absolute column (1-indexed)
		}

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		this.hardwareCursorCol = targetCol;
		this.setHardwareCursorVisible(this.getShowHardwareCursor());
	}

	/** Show or hide the hardware cursor, writing only when the state changes. */
	private setHardwareCursorVisible(visible: boolean): void {
		if (this.hardwareCursorVisible === visible) return;
		this.hardwareCursorVisible = visible;
		if (visible) this.terminal.showCursor();
		else this.terminal.hideCursor();
	}
}
