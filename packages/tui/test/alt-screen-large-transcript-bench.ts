/**
 * Alternate-screen large-transcript benchmark.
 *
 * Mirrors the fullscreen transcript shape used by the coding agent:
 *
 * ScrollView
 * └── document Container
 *     ├── header Container
 *     ├── resources Container
 *     └── chat Container
 *         └── 2,500 alternating user/assistant blocks, each a Markdown component wrapped in
 *             `NESTING` plain Containers (the coding agent wraps every block in a message and a
 *             content container, so row addressing has to cross those container boundaries)
 *
 * Measures frames that re-render: steady (nothing changed but a full re-render was forced), a
 * one-line scroll, an editor keystroke, streaming updates to the final assistant block, and width
 * changes that invalidate Markdown caches. A frame whose components did not change at all takes the
 * reuse path instead (see `reusableOutput` in layout.ts) and is not measured here.
 *
 * Run from the repository root:
 *   node --experimental-strip-types packages/tui/test/alt-screen-large-transcript-bench.ts [nesting]
 */

import { performance } from "node:perf_hooks";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Terminal } from "../src/terminal.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

const COLUMNS = 80;
const ROWS = 50;
const COMPONENT_COUNT = 2_500;
const WARMUP_FRAMES = 20;

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

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
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

const userMarkdown = [
	"## User request",
	"",
	"Please inspect this implementation carefully and report the relevant behavior.",
	"",
	"- preserve correctness",
	"- include concrete evidence",
].join("\n");

const assistantMarkdown = [
	"## Analysis",
	"",
	"This response contains representative prose with **inline styles**, a [link](https://example.com), and enough words to wrap across terminal rows at realistic widths. The implementation should preserve all observable behavior while avoiding unnecessary allocation.",
	"",
	"1. First item with explanatory text and a concrete example.",
	"2. Second item with more explanatory text and another example.",
	"3. Third item that ensures list rendering is represented.",
	"",
	"```ts",
	"function render(width: number): string[] {",
	"  const lines: string[] = [];",
	"  for (const child of children) {",
	"    const childLines = child.render(width);",
	"    for (const line of childLines) lines.push(line);",
	"  }",
	"  const height = lines.length;",
	"  const start = Math.max(0, from);",
	"  const end = Math.min(height, start + count);",
	"  const visible = lines.slice(start, end);",
	"  updateLayout(height, viewportHeight);",
	"  return visible;",
	"}",
	"```",
	"",
	"> A quoted conclusion with enough text to exercise wrapping and inline rendering in the real Markdown component.",
	"",
	"Final paragraph with a concise recommendation and a note about correctness tests.",
].join("\n");

/** Wrap a block the way the coding agent's message components do. */
function wrap(block: Markdown, nesting: number): Component {
	let component: Component = block;
	for (let level = 0; level < nesting; level++) {
		const wrapper = new Container();
		wrapper.addChild(component);
		component = wrapper;
	}
	return component;
}

/** One fullscreen world: the transcript plus an editor row in the dock. */
function createWorld(nesting: number) {
	const header = new Container();
	header.addChild(new Text("pi benchmark\nheader line", 0, 0));
	const resources = new Container();
	resources.addChild(new Text("resource", 0, 0));
	const chat = new Container();
	let streamingMarkdown: Markdown | undefined;
	for (let index = 0; index < COMPONENT_COUNT; index++) {
		const markdown = new Markdown(index % 2 === 0 ? userMarkdown : assistantMarkdown, 1, 0, theme);
		chat.addChild(wrap(markdown, nesting));
		if (index === COMPONENT_COUNT - 1) streamingMarkdown = markdown;
	}
	if (!streamingMarkdown) throw new Error("Benchmark requires at least one assistant Markdown component");

	const document = new Container();
	document.addChild(header);
	document.addChild(resources);
	document.addChild(chat);

	const transcript = new ScrollView(document, { follow: "none", primary: true });
	const editor = new Text("editor", 0, 0);
	const dock = new VStack([editor]);
	const root = new VStack([
		{ component: transcript, basis: 0, grow: 1, minSize: 1 },
		{ component: dock, basis: "auto", minSize: 1 },
	]);
	const terminal = new NullTerminal();
	const tui = new TuiAltScreen(terminal, false, "/tmp/pi-tui-bench");
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow();

	const totalLines = document.render(terminal.columns).length;
	transcript.scrollTo(Math.floor(totalLines / 2));
	for (let frame = 0; frame < WARMUP_FRAMES; frame++) tui.renderNow();

	const measure = (name: string, frames: number, beforeFrame: (frame: number) => void): void => {
		const start = performance.now();
		for (let frame = 0; frame < frames; frame++) {
			beforeFrame(frame);
			tui.renderNow();
		}
		const millisecondsPerFrame = (performance.now() - start) / frames;
		console.log(`  ${name}: ${millisecondsPerFrame.toFixed(3)} ms/frame (${frames} frames)`);
	};

	console.log(
		`nesting=${nesting} components=${COMPONENT_COUNT} lines=${totalLines} viewport=${terminal.columns}x${terminal.rows}`,
	);
	measure("steady", 200, () => {});
	transcript.scrollTo(Math.floor(totalLines / 2));
	measure("scroll", 200, () => transcript.scrollBy(1));
	measure("typing", 200, (frame) => editor.setText(`editor ${"x".repeat((frame % 20) + 1)}`));
	measure("streaming", 100, (frame) => {
		streamingMarkdown.setText(`${assistantMarkdown}\n\nstream ${"x".repeat(frame + 1)}`);
	});
	measure("resize", 10, (frame) => {
		terminal.columns = frame % 2 === 0 ? COLUMNS - 1 : COLUMNS;
	});

	tui.stop();
}

for (const nesting of (process.argv[2] ?? "0,2").split(",").map(Number)) createWorld(nesting);
