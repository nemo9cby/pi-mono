import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	Agent,
	type AgentEvent,
	type AgentOptions,
	type StreamFn,
	type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtractSourceToolDetails } from "../tools/extract-source.js";
import { createDeepResearchTools, resolvePathWithinRoot, toPromptPath } from "../tools/index.js";
import type { WebSearchToolDetails } from "../tools/web-search.js";
import { convertToLlm, createResearchStatusMessage } from "./messages.js";
import { renderReportHtml } from "./report-renderer.js";
import {
	buildDeepResearchSystemPrompt,
	buildDeepResearchUserPrompt,
	REQUIRED_QUESTION_HEADINGS,
	REQUIRED_REPORT_HEADINGS,
} from "./system-prompt.js";

export interface DeepResearchSessionOptions {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	workingDirectory?: string;
	reportsRoot?: string;
	maxTurns?: number;
	streamFn?: StreamFn;
	apiKey?: string;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export interface SourceReference {
	url: string;
	title?: string;
	source?: string;
	snippet?: string;
	addedAt: string;
}

export interface ReportValidation {
	hasAllRequiredHeadings: boolean;
	missingHeadings: string[];
	answeredRequiredQuestions: boolean;
	hasRelatedWorkComparison: boolean;
	hasReferenceUrls: boolean;
	isComplete: boolean;
}

export interface DeepResearchRunResult {
	seedUrl: string;
	reportDirectory: string;
	reportPath: string;
	reportHtmlPath: string;
	sourcesPath: string;
	turnCount: number;
	validation: ReportValidation;
}

export type DeepResearchSessionEvent =
	| AgentEvent
	| {
			type: "report_finalized";
			reportPath: string;
			reportHtmlPath: string;
			sourcesPath: string;
			validation: ReportValidation;
	  };

interface RunState {
	turnCount: number;
	maxTurnsExceeded: boolean;
	sources: Map<string, SourceReference>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isWebSearchToolDetails(value: unknown): value is WebSearchToolDetails {
	if (!isRecord(value) || !isString(value.query) || !Array.isArray(value.results)) {
		return false;
	}
	return value.results.every(
		(entry) =>
			isRecord(entry) &&
			isString(entry.title) &&
			isString(entry.url) &&
			isString(entry.snippet) &&
			isString(entry.source),
	);
}

function isExtractSourceToolDetails(value: unknown): value is ExtractSourceToolDetails {
	if (!isRecord(value)) {
		return false;
	}

	if (!isString(value.title) || !isString(value.canonicalUrl) || !isString(value.sourceType)) {
		return false;
	}

	const sourceType = value.sourceType;
	if (sourceType !== "arxiv" && sourceType !== "pdf" && sourceType !== "html" && sourceType !== "other") {
		return false;
	}

	return true;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasHeading(markdown: string, heading: string): boolean {
	return new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m").test(markdown);
}

function getSectionBody(markdown: string, heading: string): string {
	const lines = markdown.replaceAll("\r\n", "\n").split("\n");
	const sectionIndex = lines.findIndex((line) => line.trim() === heading.trim());
	if (sectionIndex === -1) {
		return "";
	}

	const headingLevelMatch = heading.match(/^(#+)\s+/);
	const headingLevel = headingLevelMatch ? headingLevelMatch[1].length : 1;
	let endIndex = lines.length;

	for (let index = sectionIndex + 1; index < lines.length; index += 1) {
		const match = lines[index].trim().match(/^(#+)\s+/);
		if (!match) {
			continue;
		}

		const nextHeadingLevel = match[1].length;
		if (nextHeadingLevel <= headingLevel) {
			endIndex = index;
			break;
		}
	}

	return lines
		.slice(sectionIndex + 1, endIndex)
		.join("\n")
		.trim();
}

function validateReport(markdown: string): ReportValidation {
	const missingHeadings = REQUIRED_REPORT_HEADINGS.filter((heading) => !hasHeading(markdown, heading));
	const answeredRequiredQuestions = REQUIRED_QUESTION_HEADINGS.every(
		(heading) => getSectionBody(markdown, heading).length >= 120,
	);

	const relatedWorkText = getSectionBody(markdown, "## 3. Related Work and Key Differences");
	const hasComparisonKeyword = /(compare|compared|difference|differ|similar|whereas|unlike|in contrast)/i.test(
		relatedWorkText,
	);
	const hasComparisonCitation = /\[\d+\]/.test(relatedWorkText) || /https?:\/\/\S+/i.test(relatedWorkText);
	const hasRelatedWorkComparison = hasComparisonKeyword && hasComparisonCitation;

	const referencesText = getSectionBody(markdown, "## References");
	const referenceMatches = referencesText.match(/https?:\/\/\S+/g) ?? [];
	const hasReferenceUrls = referenceMatches.length > 0;

	const hasAllRequiredHeadings = missingHeadings.length === 0;
	const isComplete =
		hasAllRequiredHeadings && answeredRequiredQuestions && hasRelatedWorkComparison && hasReferenceUrls;

	return {
		hasAllRequiredHeadings,
		missingHeadings,
		answeredRequiredQuestions,
		hasRelatedWorkComparison,
		hasReferenceUrls,
		isComplete,
	};
}

function parseArxivId(seedUrl: URL): string | undefined {
	if (!seedUrl.hostname.endsWith("arxiv.org")) {
		return undefined;
	}
	const absMatch = seedUrl.pathname.match(/^\/abs\/([^/?#]+)/);
	if (absMatch) {
		return absMatch[1];
	}
	const pdfMatch = seedUrl.pathname.match(/^\/pdf\/([^/?#]+?)(?:\.pdf)?$/);
	if (pdfMatch) {
		return pdfMatch[1];
	}
	return undefined;
}

function sanitizeSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
}

function createPaperSlug(seedUrl: URL): string {
	const arxivId = parseArxivId(seedUrl);
	if (arxivId) {
		return sanitizeSlug(`arxiv-${arxivId}`) || "arxiv-paper";
	}

	const pathFragment = seedUrl.pathname.split("/").filter(Boolean).join("-");
	const rawSlug = `${seedUrl.hostname}-${pathFragment}`;
	const slug = sanitizeSlug(rawSlug);
	return slug.length > 0 ? slug.slice(0, 80) : "paper";
}

export class DeepResearchSession {
	private readonly agent: Agent;
	private readonly workingDirectory: string;
	private readonly reportsRoot: string;
	private readonly maxTurns: number;
	private readonly listeners = new Set<(event: DeepResearchSessionEvent) => void>();
	private currentRun?: RunState;

	constructor(options: DeepResearchSessionOptions) {
		this.workingDirectory = resolve(options.workingDirectory ?? process.cwd());
		this.reportsRoot = options.reportsRoot ?? "reports";
		this.maxTurns = Math.max(1, options.maxTurns ?? 24);

		const thinkingLevel =
			options.thinkingLevel ?? (options.model.reasoning ? ("medium" as ThinkingLevel) : ("off" as ThinkingLevel));

		const agentOptions: AgentOptions = {
			initialState: {
				systemPrompt: "",
				model: options.model,
				thinkingLevel,
				tools: createDeepResearchTools(this.workingDirectory),
			},
			convertToLlm,
		};

		if (options.streamFn) {
			agentOptions.streamFn = options.streamFn;
		}
		if (options.getApiKey || options.apiKey) {
			agentOptions.getApiKey = options.getApiKey ?? (() => options.apiKey);
		}

		this.agent = new Agent(agentOptions);
		this.agent.subscribe((event) => this.handleAgentEvent(event));
	}

	get state() {
		return this.agent.state;
	}

	subscribe(listener: (event: DeepResearchSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	abort() {
		this.agent.abort();
	}

	private emit(event: DeepResearchSessionEvent) {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	private addSource(source: Omit<SourceReference, "addedAt">) {
		if (!this.currentRun) {
			return;
		}

		const existing = this.currentRun.sources.get(source.url);
		const now = new Date().toISOString();

		if (!existing) {
			this.currentRun.sources.set(source.url, { ...source, addedAt: now });
			return;
		}

		this.currentRun.sources.set(source.url, {
			...existing,
			title: existing.title || source.title,
			snippet: existing.snippet || source.snippet,
			source: existing.source || source.source,
			addedAt: existing.addedAt,
		});
	}

	private ingestToolSources(toolName: string, result: unknown) {
		if (!isRecord(result)) {
			return;
		}

		const details = result.details;

		if (toolName === "web_search" && isWebSearchToolDetails(details)) {
			for (const searchResult of details.results) {
				this.addSource({
					url: searchResult.url,
					title: searchResult.title,
					snippet: searchResult.snippet,
					source: searchResult.source,
				});
			}
			return;
		}

		if (toolName === "extract_source" && isExtractSourceToolDetails(details)) {
			this.addSource({
				url: details.canonicalUrl,
				title: details.title,
				snippet: details.abstract,
				source: details.sourceType,
			});
		}
	}

	private handleAgentEvent(event: AgentEvent) {
		if (this.currentRun) {
			if (event.type === "turn_end") {
				this.currentRun.turnCount += 1;
				if (this.currentRun.turnCount >= this.maxTurns && !this.currentRun.maxTurnsExceeded) {
					this.currentRun.maxTurnsExceeded = true;
					this.agent.abort();
				}
			}

			if (event.type === "tool_execution_end") {
				this.ingestToolSources(event.toolName, event.result);
			}
		}

		this.emit(event);
	}

	async run(seedPaperUrl: string): Promise<DeepResearchRunResult> {
		if (this.currentRun) {
			throw new Error("A deep research run is already in progress.");
		}

		const normalizedSeed = seedPaperUrl.trim();
		if (normalizedSeed.length === 0) {
			throw new Error("Seed paper URL must not be empty.");
		}

		let seedUrl: URL;
		try {
			seedUrl = new URL(normalizedSeed);
		} catch {
			throw new Error(`Invalid seed paper URL: ${seedPaperUrl}`);
		}

		const paperSlug = createPaperSlug(seedUrl);
		const reportDirectory = resolvePathWithinRoot(join(this.reportsRoot, paperSlug), this.workingDirectory);
		const reportPath = resolvePathWithinRoot(join(reportDirectory, "report.md"), this.workingDirectory);
		const reportHtmlPath = resolvePathWithinRoot(join(reportDirectory, "report.html"), this.workingDirectory);
		const sourcesPath = resolvePathWithinRoot(join(reportDirectory, "sources.json"), this.workingDirectory);

		await mkdir(reportDirectory, { recursive: true });

		const runState: RunState = {
			turnCount: 0,
			maxTurnsExceeded: false,
			sources: new Map<string, SourceReference>(),
		};
		this.currentRun = runState;

		this.addSource({
			url: seedUrl.toString(),
			title: "Seed Paper",
			source: "seed",
		});

		const promptReportPath = toPromptPath(reportPath, this.workingDirectory);
		const promptSourcesPath = toPromptPath(sourcesPath, this.workingDirectory);

		this.agent.setSystemPrompt(buildDeepResearchSystemPrompt());
		this.agent.appendMessage(
			createResearchStatusMessage(
				`Report directory initialized at ${toPromptPath(reportDirectory, this.workingDirectory)}`,
				"initialized",
			),
		);

		const prompt = buildDeepResearchUserPrompt({
			seedUrl: seedUrl.toString(),
			reportPath: promptReportPath,
			sourcesPath: promptSourcesPath,
		});

		try {
			await this.agent.prompt(prompt);
		} finally {
			this.currentRun = undefined;
		}

		if (runState.maxTurnsExceeded) {
			throw new Error(`Reached max turn limit (${this.maxTurns}) before the run naturally terminated.`);
		}

		let markdown: string;
		try {
			markdown = await readFile(reportPath, "utf-8");
		} catch {
			throw new Error(
				`Expected report artifact not found at ${promptReportPath}. The model likely did not write the report file.`,
			);
		}

		const html = renderReportHtml(markdown, {
			title: `Deep Research Report: ${paperSlug}`,
		});
		await writeFile(reportHtmlPath, html, "utf-8");

		const sources = [...runState.sources.values()].sort((left, right) => left.url.localeCompare(right.url));
		await writeFile(sourcesPath, JSON.stringify({ seedUrl: seedUrl.toString(), sources }, null, 2), "utf-8");

		const validation = validateReport(markdown);
		this.agent.appendMessage(
			createResearchStatusMessage(
				`Finalized report artifacts at ${promptReportPath} and ${toPromptPath(reportHtmlPath, this.workingDirectory)}`,
				"finalized",
			),
		);

		this.emit({
			type: "report_finalized",
			reportPath,
			reportHtmlPath,
			sourcesPath,
			validation,
		});

		return {
			seedUrl: seedUrl.toString(),
			reportDirectory,
			reportPath,
			reportHtmlPath,
			sourcesPath,
			turnCount: runState.turnCount,
			validation,
		};
	}
}
