/**
 * Redirect extension imports of host packages to the modules the host already runs.
 *
 * The bundled distribution inlines pi-ai, pi-tui, pi-agent-core, pi-coding-agent, and typebox, so an
 * extension that imports them would otherwise resolve a second copy from its own `node_modules`: a
 * separate module graph with separate state (providers, typebox schemas, `instanceof` failures) and a
 * full extra copy in memory. jiti avoids this by rewriting specifiers during a transform, which costs
 * a Babel pass plus retained parsed output for every extension module.
 *
 * `module.registerHooks()` resolves synchronously in this thread, so extensions can load with a plain
 * `import()` while these specifiers map to an in-memory re-export shim of the host module namespace.
 * Same specifier, same shim URL, same module instance for every extension.
 */

import { registerHooks } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Symbol key of the registry the shims read. `Symbol.for` is shared across all modules in the realm. */
const HOST_MODULES_KEY = Symbol.for("pi.hostModules");

/** Names that cannot appear as a bare export name. */
const RESERVED_EXPORT_NAMES = new Set([
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
]);

const PLAIN_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Export names worth copying into a shim; `__esModule` carries no value. */
export function shimmedExportNames(module: Record<string, unknown>): string[] {
	return Object.keys(module).filter((name) => name !== "__esModule");
}

function exportBinding(index: number, name: string): string {
	return PLAIN_IDENTIFIER.test(name) && !RESERVED_EXPORT_NAMES.has(name)
		? `v${index} as ${name}`
		: `v${index} as ${JSON.stringify(name)}`;
}

/**
 * Source of the module that re-exports a host namespace. Built from the registry so the shim holds
 * the host's values, not copies: `export const getModel = host.getModel`.
 */
export function hostModuleShimSource(specifier: string, exportNames: readonly string[]): string {
	const lines = [`const host = globalThis[Symbol.for("pi.hostModules")][${JSON.stringify(specifier)}];`];
	exportNames.forEach((name, index) => {
		lines.push(`const v${index} = host[${JSON.stringify(name)}];`);
	});
	if (exportNames.length > 0) {
		lines.push(`export { ${exportNames.map((name, index) => exportBinding(index, name)).join(", ")} };`);
	}
	return lines.join("\n");
}

function shimUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

/** Whether `parentURL` belongs to pi itself, whose own imports must keep resolving normally. */
export function isHostPackageParent(parentURL: string | undefined, packageDir: string): boolean {
	if (parentURL === undefined || !parentURL.startsWith("file:")) return false;
	const parentPath = fileURLToPath(parentURL);
	return parentPath === packageDir || parentPath.startsWith(`${packageDir}${path.sep}`);
}

export interface HostModuleHookOptions {
	/** Host modules by specifier; extensions importing these get the host instance. */
	modules: Record<string, unknown>;
	/** Directory of the running pi package; imports from inside it are not redirected. */
	packageDir: string;
}

let installed = false;

/**
 * Install the host module registry and resolve hook. Idempotent: the first call wins, and later calls
 * with different modules are ignored because `registerHooks` cannot be undone.
 */
export function installHostModuleHooks(options: HostModuleHookOptions): boolean {
	if (installed || typeof registerHooks !== "function") return false;

	const { modules, packageDir } = options;
	Object.defineProperty(globalThis, HOST_MODULES_KEY, { value: modules, configurable: true });

	const shimSources = new Map<string, string>();
	const shimFor = (specifier: string): string => {
		let source = shimSources.get(specifier);
		if (source === undefined) {
			source = shimUrl(
				hostModuleShimSource(specifier, shimmedExportNames(modules[specifier] as Record<string, unknown>)),
			);
			shimSources.set(specifier, source);
		}
		return source;
	};

	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (!(specifier in modules)) return nextResolve(specifier, context);
			if (isHostPackageParent(context.parentURL, packageDir)) return nextResolve(specifier, context);
			return { url: shimFor(specifier), shortCircuit: true };
		},
	});
	installed = true;
	return true;
}
