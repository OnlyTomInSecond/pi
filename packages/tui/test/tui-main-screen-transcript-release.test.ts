import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CountingText extends Text {
	releases = 0;

	override releaseRenderCache(): void {
		this.releases += 1;
		super.releaseRenderCache();
	}
}

class LinesComponent implements Component {
	lines: string[];
	releases = 0;

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}

	releaseRenderCache(): void {
		this.releases += 1;
	}
}

const strip = (line: string) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\s+$/, "");

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

function textLines(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

function transcriptChild(prefix: string, count: number): CountingText {
	return new CountingText(textLines(prefix, count).join("\n"), 0, 0);
}

function modelScreen(tui: TuiMainScreen, rows: number): string[] {
	const state = tui.captureRenderState();
	const screen = state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + rows).map(strip);
	while (screen.length < rows) screen.push("");
	return screen;
}

async function assertScreenMatchesModel(tui: TuiMainScreen, terminal: VirtualTerminal, context: string) {
	const actual = (await terminal.flushAndGetViewport()).map(strip);
	assert.deepStrictEqual(actual, modelScreen(tui, terminal.rows), context);
}

describe("TuiMainScreen released render caches", () => {
	it("drops the caches of committed children above the viewport", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);

		const committed = new Container();
		const first = transcriptChild("a", 10);
		const second = transcriptChild("b", 10);
		const third = transcriptChild("c", 10);
		committed.addChild(first);
		committed.addChild(second);
		committed.addChild(third);
		tui.setCommittedComponent(committed);
		tui.addChild(new LinesComponent(["editor-1", "editor-2"]));

		tui.renderNow();
		await assertScreenMatchesModel(tui, terminal, "after the first frame");

		// 32 rows on a 6-row terminal: the viewport covers rows 26..31, so the first two children
		// (rows 0..19) can only change on a full redraw, which re-renders them from source.
		assert.strictEqual(first.releases, 1);
		assert.strictEqual(second.releases, 1);
		assert.strictEqual(third.releases, 0, "a child that reaches into the viewport keeps its cache");

		// The rendered lines stay in the transcript cache, so the frame is unchanged.
		assert.deepStrictEqual(tui.captureRenderState().previousLines.slice(0, 30).map(strip), [
			...textLines("a", 10),
			...textLines("b", 10),
			...textLines("c", 10),
		]);
		tui.renderNow();
		await assertScreenMatchesModel(tui, terminal, "after a no-change frame");
	});

	it("keeps re-rendering correctly after a release", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TuiMainScreen(terminal);
		const markdown = new Markdown(
			`# Title\n\n${"body text ".repeat(40)}\n\n\`\`\`ts\nconst a = 1;\n\`\`\``,
			0,
			0,
			theme,
		);
		const committed = new Container();
		committed.addChild(markdown);
		tui.setCommittedComponent(committed);
		tui.addChild(new LinesComponent(["editor-1"]));
		tui.renderNow();
		const before = tui.captureRenderState().previousLines.map(strip);

		// A width change re-renders the released component and must reproduce the same content.
		terminal.resize(30, 6);
		tui.renderNow();
		const after = tui.captureRenderState().previousLines.map(strip);
		assert.notDeepStrictEqual(after, before, "the narrower terminal reflows the paragraph");
		assert.ok(after.every((line) => strip(line) === line));
		await assertScreenMatchesModel(tui, terminal, "after the full redraw");
	});

	it("does not release the same child twice", () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		const committed = new Container();
		const child = transcriptChild("a", 30);
		committed.addChild(child);
		tui.setCommittedComponent(committed);
		tui.addChild(new LinesComponent(["editor-1"]));
		tui.renderNow();
		const releases = child.releases;
		tui.renderNow();
		tui.renderNow();
		assert.strictEqual(child.releases, releases);
		assert.ok(releases <= 1);
	});
});
