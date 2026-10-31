/**
 * V8 semi-space cap applied by every CLI entry point.
 *
 * V8 reads `--max-semi-space-size` while it creates the heap, so the flag cannot be applied from
 * JavaScript later (`v8.setFlagsFromString` is a no-op for it). On 64-bit hosts V8 grows both
 * semi-spaces to ~32 MB; pi's heaviest allocation burst is rendering a long session, which creates
 * many short-lived line strings, and the live new-space footprint stays around 1 MB. RSS therefore
 * pays for ~67 MB of committed pages that hold almost nothing. Capping the semi-space at 8 MB
 * measured 30-60 MB lower RSS in the TUI.
 *
 * See `restart-with-heap-limits.ts`, which applies the decision to the running process.
 */

const TUNED_ENV = "PI_HEAP_TUNED";

/** Semi-space cap in MB. */
export const MAX_SEMI_SPACE_MB = 8;

export interface HeapTuningInput {
	env: NodeJS.ProcessEnv;
	execArgv: readonly string[];
}

/**
 * Arguments that re-launch the current script with the semi-space cap, or `undefined` to keep the
 * flags the process was started with.
 */
export function heapTuningArgs(input: HeapTuningInput): string[] | undefined {
	if (input.env[TUNED_ENV] === "1") return undefined;
	// Leave an explicit choice alone, whether it came from the shell or from the parent process.
	if (input.env.NODE_OPTIONS?.includes("semi-space")) return undefined;
	if (input.execArgv.some((arg) => arg.includes("semi-space"))) return undefined;
	return [`--max-semi-space-size=${MAX_SEMI_SPACE_MB}`];
}

/** Mark the re-launched process so it does not restart again. */
export function markHeapTuned(env: NodeJS.ProcessEnv): void {
	env[TUNED_ENV] = "1";
}

/** Compiled binaries (Bun, Node SEA) have no `node <script>` invocation to re-launch. */
export function canRestartProcess(): boolean {
	if ((process.versions as { bun?: string }).bun !== undefined) return false;
	if ("sea" in process.features && process.features.sea === true) return false;
	// Not available on Windows or IBM i.
	if (typeof process.execve !== "function") return false;
	return process.argv[1] !== undefined;
}
