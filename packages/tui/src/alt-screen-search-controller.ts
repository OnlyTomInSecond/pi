import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	type AltScreenSearchMatch,
	getAltScreenSearchMatchKey,
} from "./alt-screen-search.ts";
import type { ScrollView } from "./components/scroll-view.ts";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease } from "./keys.ts";
import { getScrollbarGeometry, getScrollViewBox, type LayoutFrame } from "./layout.ts";
import { isImageLine } from "./terminal-image.ts";
import type { Component, OverlayHandle, OverlayOptions } from "./tui.ts";
import { extractAnsiCode, sliceByColumn, visibleWidth } from "./utils.ts";

type SearchSelectionMode = "query" | "retain" | "next" | "previous";

interface ActiveSearch {
	component: AltScreenSearchComponent;
	index: AltScreenSearchIndex;
	overlay?: OverlayHandle;
	query: string;
	matches: AltScreenSearchMatch[];
	selectedIndex: number;
	selectedKey?: string;
	anchorRow: number;
	selectionMode: SearchSelectionMode;
}

interface SearchHighlightRange {
	startCol: number;
	endCol: number;
	current: boolean;
}

export interface SearchMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

export interface SearchStyleOptions {
	matchStyle: (text: string) => string;
	currentMatchStyle: (text: string) => string;
	navigationButtonStyle: (text: string, hovered: boolean) => string;
}

/** Renderer access needed by {@link AltScreenSearch}. */
export interface SearchHost {
	getPrimaryScrollView(): ScrollView;
	getImplicitScrollView(): ScrollView;
	getColumns(): number;
	requestRender(): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
}

/**
 * Owns the fullscreen transcript search overlay: query state, match navigation, keyboard/mouse
 * interaction, and match highlighting. The index and panel component live in `alt-screen-search.ts`.
 */
export class AltScreenSearch {
	private readonly host: SearchHost;
	private readonly matchStyle: (text: string) => string;
	private readonly currentMatchStyle: (text: string) => string;
	private readonly navigationButtonStyle: (text: string, hovered: boolean) => string;
	private active?: ActiveSearch;

	constructor(host: SearchHost, styles: SearchStyleOptions) {
		this.host = host;
		this.matchStyle = styles.matchStyle;
		this.currentMatchStyle = styles.currentMatchStyle;
		this.navigationButtonStyle = styles.navigationButtonStyle;
	}

	isActive(): boolean {
		return this.active !== undefined;
	}

	isFocused(): boolean {
		return this.active?.overlay?.isFocused() === true;
	}

	close(): void {
		const search = this.active;
		if (!search) return;
		this.active = undefined;
		search.overlay?.hide();
		this.host.requestRender();
	}

	toggle(): void {
		if (this.active) {
			this.close();
			return;
		}
		const component = new AltScreenSearchComponent((query) => this.updateQuery(query), this.navigationButtonStyle);
		const search: ActiveSearch = {
			component,
			index: new AltScreenSearchIndex(),
			query: "",
			matches: [],
			selectedIndex: -1,
			anchorRow: this.host.getPrimaryScrollView().scrollTop,
			selectionMode: "query",
		};
		this.active = search;
		search.overlay = this.host.showOverlay(component, {
			anchor: "top-right",
			width: "40%",
			minWidth: 32,
			margin: 1,
		});
	}

	/** Clear the hovered navigation-button highlight when the terminal loses focus. */
	clearHover(): void {
		if (this.active?.component.setHoveredNavigationDirection(undefined)) this.host.requestRender();
	}

	/** Consume search-related keybindings; returns true when the input was handled. */
	handleInput(data: string): boolean {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.altScreen.search")) {
			if (!isKeyRelease(data)) this.toggle();
			return true;
		}
		if (this.active?.overlay?.isFocused()) {
			const isRelease = isKeyRelease(data);
			if (keybindings.matches(data, "tui.altScreen.searchNext")) {
				if (!isRelease) this.navigate(1);
				return true;
			}
			if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
				if (!isRelease) this.navigate(-1);
				return true;
			}
			if (keybindings.matches(data, "tui.altScreen.searchClose")) {
				if (!isRelease) this.close();
				return true;
			}
		}
		return false;
	}

	handleMouseEvent(event: SearchMouseEvent): boolean {
		const search = this.active;
		if (!search) return false;
		const direction = this.getNavigationDirectionAt(event.x, event.y);
		if (search.component.setHoveredNavigationDirection(direction)) this.host.requestRender();
		if (direction === undefined || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) {
			return false;
		}
		this.navigate(direction);
		return true;
	}

	/** Recompute matches for the current query against a fresh layout; returns whether the viewport scrolled. */
	refresh(layout: LayoutFrame): boolean {
		const search = this.active;
		if (!search) return false;
		const scrollView = layout.primaryScrollView ?? this.host.getImplicitScrollView();
		const box = getScrollViewBox(layout, scrollView);
		const lines = box?.scrollContentLines;
		if (!lines || !search.query.trim()) {
			search.matches = [];
			search.selectedIndex = -1;
			search.selectedKey = undefined;
			search.selectionMode = "retain";
			search.component.setResult(-1, 0);
			return false;
		}

		const shouldRevealSelection = search.selectionMode !== "retain";
		const result = search.index.search(lines, search.query);
		const matches = result.matches;
		search.matches = matches;
		if (!result.changed && search.selectionMode === "retain") return false;

		const exactIndex = result.changed
			? search.selectedKey
				? matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.selectedKey)
				: -1
			: search.selectedIndex;
		let selectedIndex = -1;
		if (matches.length > 0) {
			if (search.selectionMode === "query") {
				let low = 0;
				let high = matches.length;
				while (low < high) {
					const middle = low + Math.floor((high - low) / 2);
					if ((matches[middle]!.segments[0]?.row ?? 0) < search.anchorRow) low = middle + 1;
					else high = middle;
				}
				selectedIndex = low < matches.length ? low : 0;
			} else if (search.selectionMode === "next") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
			} else if (search.selectionMode === "previous") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? matches.length - 1 : (baseIndex - 1 + matches.length) % matches.length;
			} else {
				selectedIndex =
					exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
			}
		}

		search.selectedIndex = selectedIndex;
		search.selectedKey = selectedIndex >= 0 ? getAltScreenSearchMatchKey(matches[selectedIndex]!) : undefined;
		search.selectionMode = "retain";
		search.component.setResult(selectedIndex, matches.length);
		if (!shouldRevealSelection) return false;

		const selected = matches[selectedIndex];
		const firstSegment = selected?.segments[0];
		const lastSegment = selected?.segments[selected.segments.length - 1];
		if (!box || !firstSegment || !lastSegment || scrollView.viewportHeight <= 0) return false;
		const before = scrollView.scrollTop;
		const visibleBottom = before + scrollView.viewportHeight - 1;
		let target = before;
		if (firstSegment.row < before || lastSegment.row > visibleBottom) {
			target = firstSegment.row - Math.floor(scrollView.viewportHeight / 3);
		}
		scrollView.scrollTo(target, { disableFollow: true });
		return scrollView.scrollTop !== before;
	}

	/** Composite match highlights for the current search onto a rendered screen. */
	applyHighlights(screen: string[], layout: LayoutFrame): string[] {
		const search = this.active;
		if (!search || search.selectedIndex < 0 || search.matches.length === 0) return screen;
		const scrollView = layout.primaryScrollView ?? this.host.getImplicitScrollView();
		const box = getScrollViewBox(layout, scrollView);
		if (!box) return screen;

		const rangesByRow = new Map<number, SearchHighlightRange[]>();
		const scrollbarColumn = getScrollbarGeometry(box)?.column;
		const minRow = Math.max(0, box.rect.y, box.clip.y);
		const maxRow = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
		const minColumn = Math.max(0, box.rect.x, box.clip.x);
		const maxColumn = Math.min(
			this.host.getColumns(),
			box.rect.x + box.rect.width,
			box.clip.x + box.clip.width,
			scrollbarColumn ?? Number.POSITIVE_INFINITY,
		);
		const minContentRow = scrollView.scrollTop + minRow - box.rect.y;
		const maxContentRow = scrollView.scrollTop + maxRow - box.rect.y - 1;
		let low = 0;
		let high = search.matches.length;
		while (low < high) {
			const middle = low + Math.floor((high - low) / 2);
			const match = search.matches[middle]!;
			const lastRow = match.segments[match.segments.length - 1]?.row ?? -1;
			if (lastRow < minContentRow) low = middle + 1;
			else high = middle;
		}
		for (let matchIndex = low; matchIndex < search.matches.length; matchIndex++) {
			const match = search.matches[matchIndex]!;
			if ((match.segments[0]?.row ?? 0) > maxContentRow) break;
			for (const segment of match.segments) {
				const row = box.rect.y + segment.row - scrollView.scrollTop;
				if (row < minRow || row >= maxRow) continue;
				const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
				const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
				if (endCol <= startCol) continue;
				const ranges = rangesByRow.get(row) ?? [];
				ranges.push({ startCol, endCol, current: matchIndex === search.selectedIndex });
				rangesByRow.set(row, ranges);
			}
		}

		const result = [...screen];
		for (const [row, ranges] of rangesByRow) {
			let line = result[row] ?? "";
			if (isImageLine(line)) continue;
			const lineWidth = visibleWidth(line);
			for (const range of ranges.sort((a, b) => b.startCol - a.startCol)) {
				const startCol = Math.min(range.startCol, lineWidth);
				const endCol = Math.min(range.endCol, lineWidth);
				if (endCol <= startCol) continue;
				const before = sliceByColumn(line, 0, startCol, true);
				const highlighted = sliceByColumn(line, startCol, endCol - startCol, true);
				const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
				line = `${before}${this.applyTextHighlight(highlighted, range.current)}${after}`;
			}
			result[row] = line;
		}
		return result;
	}

	private updateQuery(query: string): void {
		const search = this.active;
		if (!search || query === search.query) return;
		const selected = search.matches[search.selectedIndex];
		search.anchorRow = selected?.segments[0]?.row ?? this.host.getPrimaryScrollView().scrollTop;
		search.query = query;
		search.selectionMode = "query";
		search.component.setResult(-1, 0);
		this.host.requestRender();
	}

	private navigate(direction: -1 | 1): void {
		const search = this.active;
		if (!search?.query) return;
		search.selectionMode = direction < 0 ? "previous" : "next";
		this.host.requestRender();
	}

	private getNavigationDirectionAt(x: number, y: number): -1 | 1 | undefined {
		const search = this.active;
		const bounds = search?.overlay?.getBounds();
		if (!search || !bounds) return undefined;
		if (x < bounds.col || x >= bounds.col + bounds.width || y < bounds.row || y >= bounds.row + bounds.height) {
			return undefined;
		}
		return search.component.getNavigationDirectionAt(y - bounds.row, x - bounds.col);
	}

	private applyTextHighlight(text: string, current: boolean): string {
		const style = current ? this.currentMatchStyle : this.matchStyle;
		let result = "";
		let plainStart = 0;
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				index += 1;
				continue;
			}
			if (index > plainStart) result += style(text.slice(plainStart, index));
			result += ansi.code;
			index += ansi.length;
			plainStart = index;
		}
		if (plainStart < text.length) result += style(text.slice(plainStart));
		return result;
	}
}
