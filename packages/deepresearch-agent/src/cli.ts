#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getEnvApiKey, getModel, type Usage } from "@mariozechner/pi-ai";
import { DeepResearchSession, type DeepResearchSessionEvent } from "./core/session.js";

// ── Arg parsing ────────────────────────────────────────────────────

interface CliArgs {
	seedUrl: string;
	provider: string;
	model: string;
	maxTurns: number;
	thinking: ThinkingLevel;
	output: string;
	verbose: boolean;
	help: boolean;
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function printUsage() {
	console.log(`Usage: pi-deepresearch <seed-url> [options]

Arguments:
  seed-url                   URL of the paper to research (e.g. https://arxiv.org/abs/2301.00001)

Options:
  --provider <provider>      LLM provider (default: anthropic)
  --model <model-id>         Model ID (default: claude-sonnet-4-20250514)
  --max-turns <n>            Max agent turns (default: 24)
  --thinking <level>         off|minimal|low|medium|high|xhigh
  --output <dir>             Working directory (default: cwd)
  --verbose                  Show tool args, errors, model text; write trace.jsonl
  --help                     Show this help message`);
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		seedUrl: "",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		maxTurns: 24,
		thinking: "medium",
		output: process.cwd(),
		verbose: false,
		help: false,
	};

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];

		if (arg === "--help" || arg === "-h") {
			args.help = true;
			i++;
			continue;
		}

		if (arg === "--provider") {
			args.provider = argv[++i] ?? "";
			i++;
			continue;
		}

		if (arg === "--model") {
			args.model = argv[++i] ?? "";
			i++;
			continue;
		}

		if (arg === "--max-turns") {
			const value = parseInt(argv[++i] ?? "", 10);
			if (Number.isNaN(value) || value < 1) {
				console.error("Error: --max-turns must be a positive integer");
				process.exit(1);
			}
			args.maxTurns = value;
			i++;
			continue;
		}

		if (arg === "--thinking") {
			const level = argv[++i] ?? "";
			if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
				console.error(`Error: --thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
				process.exit(1);
			}
			args.thinking = level as ThinkingLevel;
			i++;
			continue;
		}

		if (arg === "--output") {
			args.output = argv[++i] ?? "";
			i++;
			continue;
		}

		if (arg === "--verbose") {
			args.verbose = true;
			i++;
			continue;
		}

		if (arg.startsWith("-")) {
			console.error(`Error: unknown option '${arg}'`);
			printUsage();
			process.exit(1);
		}

		// Positional: seed URL
		if (!args.seedUrl) {
			args.seedUrl = arg;
		} else {
			console.error(`Error: unexpected argument '${arg}'`);
			printUsage();
			process.exit(1);
		}

		i++;
	}

	return args;
}

// ── Formatting helpers ─────────────────────────────────────────────

function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

function formatCost(dollars: number): string {
	return `$${dollars.toFixed(4)}`;
}

// ── LLM usage tracking ────────────────────────────────────────────

interface UsageTotals {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
}

function createUsageTotals(): UsageTotals {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 };
}

function accumulateUsage(totals: UsageTotals, usage: Usage): void {
	totals.calls++;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.totalTokens += usage.totalTokens;
	totals.totalCost += usage.cost.total;
}

// ── Event handler ──────────────────────────────────────────────────

function extractAssistantText(msg: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "toolCall") {
			parts.push(`[tool_call: ${block.name}]`);
		}
	}
	return parts.join("\n");
}

function extractErrorText(result: unknown): string {
	if (result == null) return "(no details)";
	if (typeof result === "string") return result;
	if (typeof result === "object" && "content" in result) {
		const content = (result as { content?: unknown[] }).content;
		if (Array.isArray(content)) {
			return content
				.filter(
					(b): b is { type: "text"; text: string } =>
						typeof b === "object" && b !== null && (b as any).type === "text",
				)
				.map((b) => b.text)
				.join("\n");
		}
	}
	return JSON.stringify(result, null, 2);
}

function handleEvent(event: DeepResearchSessionEvent, totals: UsageTotals, verbose: boolean): void {
	switch (event.type) {
		case "turn_start":
			console.log(`\n── Turn ${totals.calls + 1} ──`);
			break;

		case "message_end":
			if (event.message.role === "assistant") {
				const msg = event.message as AssistantMessage;
				accumulateUsage(totals, msg.usage);
				console.log(
					`  LLM #${totals.calls}: ${formatTokens(msg.usage.totalTokens)} tokens (${formatCost(msg.usage.cost.total)})`,
				);
				if (verbose) {
					const text = extractAssistantText(msg);
					if (text.length > 0) {
						const preview = text.length > 500 ? `${text.slice(0, 500)}...` : text;
						console.log(`  ┄┄┄ model output ┄┄┄`);
						for (const line of preview.split("\n")) {
							console.log(`  │ ${line}`);
						}
						console.log(`  ┄┄┄`);
					}
				}
			}
			break;

		case "tool_execution_start":
			if (verbose) {
				const argsStr = JSON.stringify(event.args, null, 2);
				const preview = argsStr.length > 300 ? `${argsStr.slice(0, 300)}...` : argsStr;
				console.log(`  ▶ ${event.toolName}(${preview})`);
			} else {
				console.log(`  ▶ ${event.toolName}`);
			}
			break;

		case "tool_execution_end":
			if (event.isError) {
				if (verbose) {
					const errText = extractErrorText(event.result);
					console.log(`  ✗ ${event.toolName} failed: ${errText}`);
				} else {
					console.log(`  ✗ ${event.toolName} failed`);
				}
			}
			break;

		case "report_finalized":
			console.log(`\n  Report:     ${event.reportPath}`);
			console.log(`  HTML:       ${event.reportHtmlPath}`);
			console.log(`  Sources:    ${event.sourcesPath}`);
			console.log(`  Validation: ${event.validation.isComplete ? "PASS" : "INCOMPLETE"}`);
			if (event.validation.missingHeadings.length > 0) {
				console.log(`  Missing:    ${event.validation.missingHeadings.join(", ")}`);
			}
			break;
	}
}

// ── Main ───────────────────────────────────────────────────────────

async function main(argv: string[]) {
	const args = parseArgs(argv);

	if (args.help) {
		printUsage();
		process.exit(0);
	}

	if (!args.seedUrl) {
		console.error("Error: seed URL is required\n");
		printUsage();
		process.exit(1);
	}

	// Resolve model
	const model = getModel(args.provider as any, args.model as any);
	if (!model) {
		console.error(`Error: unknown provider/model combination: ${args.provider}/${args.model}`);
		process.exit(1);
	}

	console.log(`pi-deepresearch`);
	console.log(`  Seed URL:   ${args.seedUrl}`);
	console.log(`  Model:      ${args.provider}/${model.id}`);
	console.log(`  Max turns:  ${args.maxTurns}`);
	console.log(`  Thinking:   ${args.thinking}`);
	console.log(`  Output dir: ${args.output}`);

	const session = new DeepResearchSession({
		model,
		thinkingLevel: args.thinking,
		maxTurns: args.maxTurns,
		workingDirectory: args.output,
		getApiKey: (provider) => getEnvApiKey(provider),
	});

	const totals = createUsageTotals();
	session.subscribe((event) => handleEvent(event, totals, args.verbose));

	// Handle SIGINT gracefully
	let aborted = false;
	process.on("SIGINT", () => {
		if (!aborted) {
			aborted = true;
			console.log("\nAborting...");
			session.abort();
		}
	});

	try {
		const result = await session.run(args.seedUrl);

		console.log("\n═══════════════════════════════════════════════");
		console.log("  Deep Research Complete");
		console.log("═══════════════════════════════════════════════");
		console.log(`  Report:       ${result.reportPath}`);
		console.log(`  HTML:         ${result.reportHtmlPath}`);
		console.log(`  Sources:      ${result.sourcesPath}`);
		console.log(`  Turns:        ${result.turnCount}`);
		console.log(`  Validation:   ${result.validation.isComplete ? "PASS" : "INCOMPLETE"}`);
	} catch (error) {
		console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		console.log("\n── LLM Usage Summary ──");
		console.log(`  Calls:        ${totals.calls}`);
		console.log(`  Input:        ${formatTokens(totals.input)} tokens`);
		console.log(`  Output:       ${formatTokens(totals.output)} tokens`);
		console.log(`  Cache read:   ${formatTokens(totals.cacheRead)} tokens`);
		console.log(`  Cache write:  ${formatTokens(totals.cacheWrite)} tokens`);
		console.log(`  Total tokens: ${formatTokens(totals.totalTokens)}`);
		console.log(`  Total cost:   ${formatCost(totals.totalCost)}`);

		if (args.verbose) {
			const tracePath = join(args.output, "reports", "trace.jsonl");
			const messages = session.state.messages;
			const lines = messages.map((msg) => JSON.stringify(msg));
			await writeFile(tracePath, `${lines.join("\n")}\n`, "utf-8");
			console.log(`  Trace:        ${tracePath}`);
		}
	}
}

main(process.argv.slice(2)).catch((error) => {
	console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
