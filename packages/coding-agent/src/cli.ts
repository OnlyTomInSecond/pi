#!/usr/bin/env node
// Must stay first: importing it re-launches the process with a smaller V8 semi-space before the
// rest of the CLI graph is evaluated.
import "./cli/restart-with-heap-limits.ts";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();
main(process.argv.slice(2));
