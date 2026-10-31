import { describe, expect, test } from "vitest";
import { heapTuningArgs, MAX_SEMI_SPACE_MB } from "../src/cli/heap-limits.ts";

const FLAG = `--max-semi-space-size=${MAX_SEMI_SPACE_MB}`;

describe("heapTuningArgs", () => {
	test("caps the semi-space of a plain CLI launch", () => {
		expect(heapTuningArgs({ env: {}, execArgv: [] })).toEqual([FLAG]);
	});

	test("keeps an explicit NODE_OPTIONS choice", () => {
		expect(heapTuningArgs({ env: { NODE_OPTIONS: "--max-semi-space-size=16" }, execArgv: [] })).toBeUndefined();
	});

	test("keeps an explicit execArgv choice", () => {
		expect(heapTuningArgs({ env: {}, execArgv: ["--max-semi-space-size=16"] })).toBeUndefined();
	});

	test("does not restart a process that was already relaunched", () => {
		expect(heapTuningArgs({ env: { PI_HEAP_TUNED: "1" }, execArgv: [] })).toBeUndefined();
	});

	test("ignores unrelated NODE_OPTIONS", () => {
		expect(heapTuningArgs({ env: { NODE_OPTIONS: "--enable-source-maps" }, execArgv: [] })).toEqual([FLAG]);
	});
});
