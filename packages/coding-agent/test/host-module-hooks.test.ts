import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	hostModuleShimSource,
	isHostPackageParent,
	shimmedExportNames,
} from "../src/core/extensions/host-module-hooks.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-hooks-"));

afterAll(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("host module shim source", () => {
	it("re-exports host values under valid, reserved, and unusual names", () => {
		const source = hostModuleShimSource("@example/host", ["getModel", "default", "not-an-identifier"]);
		expect(source).toContain('host["getModel"]');
		expect(source).toContain("v0 as getModel");
		expect(source).toContain('v1 as "default"');
		expect(source).toContain('v2 as "not-an-identifier"');
	});

	it("skips the __esModule marker", () => {
		expect(shimmedExportNames({ __esModule: true, value: 1 })).toEqual(["value"]);
	});
});

describe("host package parents", () => {
	it("treats pi's own files as internal", () => {
		const packageDir = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
		expect(isHostPackageParent(`file://${packageDir}/dist/bundle/chunks/a.js`, packageDir)).toBe(true);
		expect(isHostPackageParent(pathToFileURL(path.join(packageDir, "dist", "cli.js")).href, packageDir)).toBe(true);
	});

	it("treats extension files outside the package as external", () => {
		const packageDir = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
		expect(isHostPackageParent(pathToFileURL("/home/user/.pi/agent/extensions/x.ts").href, packageDir)).toBe(false);
		expect(isHostPackageParent("data:text/javascript,1", packageDir)).toBe(false);
		expect(isHostPackageParent(undefined, packageDir)).toBe(false);
	});
});

describe("host module hooks", () => {
	// vitest transforms imports itself, so the redirect has to be exercised in a real Node process.
	it("redirects an extension import to the shared host instance", () => {
		const extensionPath = path.join(tempDir, "extension.mjs");
		const secondPath = path.join(tempDir, "second.mjs");
		fs.writeFileSync(
			extensionPath,
			'import { getModel, same } from "@example/host";\nexport const value = getModel();\nexport const sameRef = same;',
		);
		fs.writeFileSync(secondPath, 'import { same } from "@example/host";\nexport const sameRef = same;');

		const moduleUrl = pathToFileURL(path.resolve(__dirname, "../src/core/extensions/host-module-hooks.ts")).href;
		const probePath = path.join(tempDir, "probe.mjs");
		fs.writeFileSync(
			probePath,
			`
				import { installHostModuleHooks } from ${JSON.stringify(moduleUrl)};
				const same = { id: 1 };
				const installed = installHostModuleHooks({
					modules: { "@example/host": { getModel: () => "host-model", same } },
					packageDir: ${JSON.stringify(path.join(tempDir, "pi-package"))},
				});
				const first = await import(${JSON.stringify(pathToFileURL(extensionPath).href)});
				const second = await import(${JSON.stringify(pathToFileURL(secondPath).href)});
				console.log(JSON.stringify({ installed, value: first.value, sameShared: first.sameRef === same, acrossExtensions: first.sameRef === second.sameRef }));
			`,
		);

		const result = spawnSync(process.execPath, [probePath], { encoding: "utf8" });
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout.trim())).toEqual({
			installed: true,
			value: "host-model",
			sameShared: true,
			acrossExtensions: true,
		});
	});

	it("leaves specifiers outside the registry alone", () => {
		const probePath = path.join(tempDir, "probe-miss.mjs");
		fs.writeFileSync(
			probePath,
			`
				import { installHostModuleHooks } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, "../src/core/extensions/host-module-hooks.ts")).href)};
				installHostModuleHooks({ modules: { "@example/host": { a: 1 } }, packageDir: ${JSON.stringify(path.join(tempDir, "pi-package"))} });
				try {
					await import("@example/missing");
					console.log(JSON.stringify({ failed: false }));
				} catch (error) {
					console.log(JSON.stringify({ failed: true, code: error.code }));
				}
			`,
		);
		const result = spawnSync(process.execPath, [probePath], { encoding: "utf8" });
		expect(JSON.parse(result.stdout.trim())).toEqual({ failed: true, code: "ERR_MODULE_NOT_FOUND" });
	});
});
