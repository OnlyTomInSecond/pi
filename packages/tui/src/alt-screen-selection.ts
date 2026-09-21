import type { ScrollView } from "./components/scroll-view.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getWordSegmenter,
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
