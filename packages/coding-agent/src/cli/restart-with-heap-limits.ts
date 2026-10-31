/**
 * Re-launch the CLI with the V8 semi-space cap from `heap-limits.ts`.
 *
 * `process.execve` swaps the process image, so the PID, stdio, TTY, and exit status are preserved.
 * Importing this module performs the re-launch, so it must be the first import of an entry point
 * (imports are evaluated in declaration order).
 */

import { canRestartProcess, heapTuningArgs, markHeapTuned } from "./heap-limits.ts";

function restartWithHeapLimits(): void {
	const execve = process.execve;
	const flags = heapTuningArgs({ env: process.env, execArgv: process.execArgv });
	if (!flags || execve === undefined || !canRestartProcess()) return;
	markHeapTuned(process.env);
	try {
		// `args` is the whole argv, so argv[0] must stay the executable; Node reads flags from
		// argv[1] onward.
		execve.call(
			process,
			process.execPath,
			[process.execPath, ...process.execArgv, ...flags, ...process.argv.slice(1)],
			process.env,
		);
	} catch {
		// Keep running with the flags we were started with.
	}
}

restartWithHeapLimits();
