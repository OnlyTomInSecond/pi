import type { ScrollView } from "./components/scroll-view.ts";
import {
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	type LayoutFrame,
	type ScrollbarGeometry,
} from "./layout.ts";

export interface ScrollbarMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

/** Renderer access needed by {@link AltScreenScrollbar}. */
export interface ScrollbarHost {
	getLayout(): LayoutFrame | undefined;
	hasOverlay(): boolean;
	/** Called when a scrollbar drag starts so the renderer can drop an active text selection. */
	clearSelection(): void;
}

interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
}

interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

/**
 * Owns fullscreen scrollbar hit-testing, hover highlight, and thumb/track dragging.
 * Scrolling itself is delegated to the targeted {@link ScrollView}; the renderer only forwards pointer events.
 */
export class AltScreenScrollbar {
	private readonly host: ScrollbarHost;
	private drag?: ScrollbarDrag;
	private hover?: ScrollView;

	constructor(host: ScrollbarHost) {
		this.host = host;
	}

	isDragging(): boolean {
		return this.drag !== undefined;
	}

	/** Update hover highlight for a pointer position (used by wheel routing and pointer motion). */
	updateHover(x: number, y: number): void {
		this.setHover(this.getTargetAt(x, y, true)?.scrollView);
	}

	stopHover(): void {
		this.setHover(undefined);
	}

	stopDrag(): void {
		this.drag = undefined;
	}

	/** Stop both hover highlight and an in-progress drag. */
	reset(): void {
		this.stopHover();
		this.stopDrag();
	}

	/** Handle a scrollbar press/drag/release; returns true when the event was consumed. */
	handleMouseEvent(event: ScrollbarMouseEvent): boolean {
		if (this.drag) {
			if (event.release) {
				this.stopDrag();
				return true;
			}
			const layout = this.host.getLayout();
			const box = layout ? getScrollViewBox(layout, this.drag.scrollView) : undefined;
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (geometry) this.scrollToPointer(this.drag.scrollView, geometry, event.y, this.drag.grabOffset);
			return true;
		}

		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		const target = this.getTargetAt(event.x, event.y);
		if (!target) return false;
		this.host.clearSelection();
		this.setHover(target.scrollView);
		const onThumb =
			event.y >= target.geometry.thumbTop && event.y < target.geometry.thumbTop + target.geometry.thumbHeight;
		const grabOffset = onThumb ? event.y - target.geometry.thumbTop : Math.floor(target.geometry.thumbHeight / 2);
		if (!onThumb) this.scrollToPointer(target.scrollView, target.geometry, event.y, grabOffset);
		this.drag = { scrollView: target.scrollView, grabOffset };
		return true;
	}

	private getTargetAt(x: number, y: number, includeHiddenAuto = false): ScrollbarTarget | undefined {
		const layout = this.host.getLayout();
		if (this.host.hasOverlay() || !layout) return undefined;
		for (const scrollView of getScrollViewsAt(layout, x, y)) {
			const box = getScrollViewBox(layout, scrollView);
			const geometry = box ? getScrollbarGeometry(box, includeHiddenAuto) : undefined;
			if (
				geometry &&
				x === geometry.column &&
				y >= geometry.trackTop &&
				y < geometry.trackTop + geometry.trackHeight
			) {
				return { scrollView, geometry };
			}
		}
		return undefined;
	}

	private setHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.hover) return;
		this.hover?.setScrollbarActive(false);
		this.hover = scrollView;
		this.hover?.setScrollbarActive(true);
	}

	private scrollToPointer(
		scrollView: ScrollView,
		geometry: ScrollbarGeometry,
		pointerY: number,
		grabOffset: number,
	): void {
		const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
		const thumbOffset = Math.max(0, Math.min(maxThumbOffset, pointerY - geometry.trackTop - grabOffset));
		const scrollTop = maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
		scrollView.scrollTo(scrollTop);
	}
}
