import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	/**
	 * Latest streaming frame when it has not been rendered yet. Provider deltas arrive far more
	 * often than the TUI renders, so frames are queued here and applied in {@link render}, which
	 * collapses a burst of deltas into one content rebuild per rendered frame.
	 */
	private pendingStreamingMessage?: AssistantMessage;
	/**
	 * Markdown components reused across frames, keyed by the content index that produces them, so a
	 * streamed block keeps its incremental render memo. Finalized messages get fresh components, so
	 * the memo is scoped to the streaming lifetime (see {@link appliedIsStreaming}).
	 */
	private textMarkdowns = new Map<number, Markdown>();
	private thinkingMarkdowns = new Map<number, Markdown>();
	/** Rendering inputs captured by the reused Markdown components; rebuild them when these change. */
	private appliedIsStreaming?: boolean;
	private appliedOutputPad?: number;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.flushPendingContent();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		this.flushPendingContent();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		this.flushPendingContent();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.flushPendingContent();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		this.flushPendingContent();
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	/** Queue the latest streaming frame. It is applied by the next {@link render}. */
	updateStreamingContent(message: AssistantMessage): void {
		this.pendingStreamingMessage = message;
	}

	private flushPendingContent(): void {
		const message = this.pendingStreamingMessage;
		if (!message) {
			return;
		}
		this.updateContent(message, true);
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.pendingStreamingMessage = undefined;
		this.lastMessage = message;

		// Markdown components capture the streaming flag and padding, so rebuild them when either
		// changes. Streaming toggles once per message, so this discards the memo for finalized text.
		if (this.appliedIsStreaming !== isStreaming || this.appliedOutputPad !== this.outputPad) {
			this.textMarkdowns.clear();
			this.thinkingMarkdowns.clear();
			this.appliedIsStreaming = isStreaming;
			this.appliedOutputPad = this.outputPad;
		}
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(this.getTextMarkdown(i, content.text.trim()));
			} else if (content.type === "thinking") {
				const runStart = i;
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const thinkingComponent = hidden
					? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
					: this.getThinkingMarkdown(runStart, thinkingBlocks.join("\n\n"));
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						this.flushPendingContent();
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}

	/**
	 * Return the Markdown for a text block, reusing the component across streaming frames so its
	 * incremental render memo survives. Reuse is limited to the streaming lifetime; finalized
	 * messages get fresh components because they do not need the memo.
	 */
	private getTextMarkdown(index: number, text: string): Markdown {
		const existing = this.textMarkdowns.get(index);
		if (existing) {
			existing.setText(text);
			return existing;
		}
		const markdown = new Markdown(text, this.outputPad, 0, this.markdownTheme, undefined, {
			transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
			incremental: this.isStreaming,
		});
		this.textMarkdowns.set(index, markdown);
		return markdown;
	}

	private getThinkingMarkdown(index: number, text: string): Markdown {
		const existing = this.thinkingMarkdowns.get(index);
		if (existing) {
			existing.setText(text);
			return existing;
		}
		const markdown = new Markdown(
			text,
			this.outputPad,
			0,
			this.markdownTheme,
			{
				color: (value: string) => theme.fg("thinkingText", value),
				italic: true,
			},
			{
				transform: createMarkdownTransform("assistant-thinking", this.isStreaming, this.markdownTransformers),
				incremental: this.isStreaming,
			},
		);
		this.thinkingMarkdowns.set(index, markdown);
		return markdown;
	}
}
