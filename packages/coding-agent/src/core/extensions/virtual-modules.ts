import * as bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as bundledPiAiCompat from "@earendil-works/pi-ai/compat";
import * as bundledPiAiModels from "@earendil-works/pi-ai/models";
import * as bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
// pi-ai exposes `./utils/*`. Extensions import these subpaths, and without an entry here jiti resolves
// them from the extension's own copy of pi-ai, which is a different module instance. The modules below
// are either already reached by the bundled entrypoints or too small to matter at startup; modules with
// import-time side effects (`provider-env` reads /proc) or heavy dependencies (`node-http-proxy`) are
// deliberately left out.
import * as bundledPiAiUtilsAbort from "@earendil-works/pi-ai/utils/abort";
import * as bundledPiAiUtilsAbortSignals from "@earendil-works/pi-ai/utils/abort-signals";
import * as bundledPiAiUtilsHeaders from "@earendil-works/pi-ai/utils/headers";
import * as bundledPiAiUtilsIdentity from "@earendil-works/pi-ai/utils/identity";
import * as bundledPiAiUtilsJsonParse from "@earendil-works/pi-ai/utils/json-parse";
import * as bundledPiAiUtilsOverflow from "@earendil-works/pi-ai/utils/overflow";
import * as bundledPiAiUtilsRetry from "@earendil-works/pi-ai/utils/retry";
import * as bundledPiAiUtilsStreamingJson from "@earendil-works/pi-ai/utils/streaming-json";
import * as bundledPiAiUtilsText from "@earendil-works/pi-ai/utils/text";
import * as bundledPiAiUtilsTranscript from "@earendil-works/pi-ai/utils/transcript";
import * as bundledPiAiUtilsTypeboxHelpers from "@earendil-works/pi-ai/utils/typebox-helpers";
import * as bundledPiAiUtilsUuid from "@earendil-works/pi-ai/utils/uuid";
import * as bundledPiAiUtilsValidation from "@earendil-works/pi-ai/utils/validation";
import * as bundledPiAiUtilsVersion from "@earendil-works/pi-ai/utils/version";
import * as bundledPiTui from "@earendil-works/pi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @earendil-works/pi-coding-agent.
import * as bundledPiCodingAgent from "../../index.ts";

const bundledPiAiUtils: Record<string, unknown> = {
	abort: bundledPiAiUtilsAbort,
	"abort-signals": bundledPiAiUtilsAbortSignals,
	headers: bundledPiAiUtilsHeaders,
	identity: bundledPiAiUtilsIdentity,
	"json-parse": bundledPiAiUtilsJsonParse,
	overflow: bundledPiAiUtilsOverflow,
	retry: bundledPiAiUtilsRetry,
	"streaming-json": bundledPiAiUtilsStreamingJson,
	text: bundledPiAiUtilsText,
	transcript: bundledPiAiUtilsTranscript,
	"typebox-helpers": bundledPiAiUtilsTypeboxHelpers,
	uuid: bundledPiAiUtilsUuid,
	validation: bundledPiAiUtilsValidation,
	version: bundledPiAiUtilsVersion,
};

/** Subpath entries for every bundled `pi-ai/utils/*` module, under both package names. */
function piAiUtilsEntries(): Record<string, unknown> {
	const entries: Record<string, unknown> = {};
	for (const [name, module] of Object.entries(bundledPiAiUtils)) {
		entries[`@earendil-works/pi-ai/utils/${name}`] = module;
		entries[`@mariozechner/pi-ai/utils/${name}`] = module;
	}
	return entries;
}

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	...piAiUtilsEntries(),
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@earendil-works/pi-agent-core": bundledPiAgentCore,
	"@earendil-works/pi-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@earendil-works/pi-ai": bundledPiAiCompat,
	"@earendil-works/pi-ai/compat": bundledPiAiCompat,
	"@earendil-works/pi-ai/models": bundledPiAiModels,
	"@earendil-works/pi-ai/oauth": bundledPiAiOauth,
	"@earendil-works/pi-ai/providers/all": bundledPiAiProviders,
	"@earendil-works/pi-coding-agent": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": bundledPiAiCompat,
	"@mariozechner/pi-ai/models": bundledPiAiModels,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
