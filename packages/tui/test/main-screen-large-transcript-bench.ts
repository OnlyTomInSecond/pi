/**
 * Regular-mode (main screen) large-transcript benchmark.
 *
 * Mirrors the shape interactive mode uses in regular TUI mode:
 *
 * committed Container (finalized transcript, cached prefix)
 * live tail Container
 *   ├── streaming Markdown (grows while the model streams)
 *   └── editor Text
 *
 * Measures warm steady frames, streaming frames as the live tail grows, the
 * commit frame that promotes finalized content into the prefix, overlay
 * compositing, and a terminal width change.
 *
 * Run from the repository root:
 *   node --experimental-strip-types packages/tui/test/main-screen-large-transcript-bench.ts
 */

import { performance } from "node:perf_hooks";
import { Box } from "../src/components/box.ts";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import type { Terminal } from "../src/terminal.ts";
import { Container } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

const COLUMNS = 100;
const ROWS = 30;
const COMMITTED_COMPONENTS = 2000;

const theme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

class NullTerminal implements Terminal {
	columns = COLUMNS;
	rows = ROWS;
	bytesWritten = 0;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytesWritten += data.length;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

const assistantMarkdown = [
	"## Analysis",
	"",
	"This response contains representative prose with **inline styles**, a [link](https://example.com), and enough words to wrap across terminal rows at realistic widths.",
	"",
	"1. First item with explanatory text and a concrete example.",
	"2. Second item with more explanatory text.",
	"",
	"```ts",
	"function render(width: number): string[] {",
	"  const lines: string[] = [];",
	"  for (const child of children) lines.push(...child.render(width));",
	"  return lines;",
	"}",
	"```",
	"",
	"> A quoted conclusion with enough text to wrap.",
	"",
	"Final paragraph with a concise recommendation.",
].join("\n");

function markdownContainer(count: number): Container {
	const container = new Container();
	for (let index = 0; index < count; index++) container.addChild(new Markdown(assistantMarkdown, 1, 0, theme));
	return container;
}

const terminal = new NullTerminal();
const tui = new TuiMainScreen(terminal, false, "/tmp/pi-tui-bench");
const committed = markdownContainer(COMMITTED_COMPONENTS);
const tail = new Container();
const pending = new Markdown(assistantMarkdown, 1, 0, theme);
tail.addChild(pending);
tail.addChild(new Text("> prompt", 1, 0));
tui.setCommittedComponent(committed);
tui.addChild(tail);
tui.start();
tui.renderNow();

function measure(name: string, frames: number, before: (frame: number) => void): void {
	const bytesBefore = terminal.bytesWritten;
	const start = performance.now();
	for (let frame = 0; frame < frames; frame++) {
		before(frame);
		tui.renderNow();
	}
	const msPerFrame = (performance.now() - start) / frames;
	const bytesPerFrame = (terminal.bytesWritten - bytesBefore) / frames;
	console.log(
		`${name.padEnd(34)} ${msPerFrame.toFixed(3).padStart(8)} ms/frame  ${bytesPerFrame.toFixed(0).padStart(9)} bytes/frame`,
	);
}

console.log(`components=${COMMITTED_COMPONENTS} committed=${committed.render(COLUMNS).length} lines`);
measure("steady", 100, () => {});

// Streaming: grow a live message and report cost while the tail is already large.
const streaming = new Markdown("", 1, 0, theme, undefined, { incremental: true });
tail.clear();
tail.addChild(streaming);
tail.addChild(new Text("> prompt", 1, 0));
let source = "";
const chunks = Array.from({ length: 400 }, (_, index) => `## Section ${index}\n\n${assistantMarkdown}\n`);
measure("streaming (small tail)", 40, (frame) => {
	source += chunks[frame]!;
	streaming.setText(source);
});
const largeTailLines = tail.render(COLUMNS).length;
measure("streaming (large tail)", 360, (frame) => {
	source += chunks[frame + 40]!;
	streaming.setText(source);
});
console.log(`large tail=${tail.render(COLUMNS).length} lines (small tail was ${largeTailLines})`);

// Truncation: the live tail loses rows while a line above the end also changes, as a reflowing
// streamed table does. This exercises the deleted-line cleanup, which must stay incremental.
const shrinking = new Markdown(assistantMarkdown.repeat(3), 1, 0, theme, undefined, { incremental: true });
tail.clear();
tail.addChild(shrinking);
tail.addChild(new Text("> prompt", 1, 0));
let shrinkSource = assistantMarkdown.repeat(3);
tui.renderNow();
measure("truncating live tail", 50, () => {
	shrinkSource = shrinkSource.slice(0, Math.max(400, shrinkSource.length - 11));
	shrinking.setText(`${shrinkSource}\n\nchanged`);
});
tail.clear();
tail.addChild(new Text("> prompt", 1, 0));
tui.renderNow();

// Overlay open, as when a selector dialog is visible.
const overlayBox = new Box(1, 1);
overlayBox.addChild(new Text("overlay content here", 1, 1));
const overlay = tui.showOverlay(overlayBox, { width: 40, anchor: "center" });
measure("overlay open", 50, () => {});
overlay.hide();
tui.renderNow();

// Commit: promote finalized content into the prefix. This mirrors
// commitFinalizedTranscript(): the finalized component was already rendered at the
// end of the tail, so it keeps its absolute position once it moves into the prefix.
const finalized = new Markdown(assistantMarkdown, 1, 0, theme);
const nextStreaming = new Markdown("", 1, 0, theme, undefined, { incremental: true });
tail.clear();
tail.addChild(finalized);
tail.addChild(new Text("> prompt", 1, 0));
tui.renderNow();
measure("commit one component", 1, () => {
	committed.addChild(finalized);
	tail.clear();
	tail.addChild(nextStreaming);
	tail.addChild(new Text("> prompt", 1, 0));
	tui.appendCommitted();
});

// Width change rewraps the committed prefix.
measure("width change", 3, (frame) => {
	terminal.columns = frame % 2 === 0 ? COLUMNS : COLUMNS - 1;
});

tui.stop();
