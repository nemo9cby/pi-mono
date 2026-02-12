import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

const webSearchSchema = Type.Object({
	query: Type.String({ minLength: 1, description: "Search query for papers, methods, or related work" }),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of results (default: 5)" }),
	),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	source: string;
}

export interface WebSearchToolDetails {
	query: string;
	results: WebSearchResult[];
	providerErrors?: string[];
}

interface SemanticScholarPaper {
	title?: string;
	url?: string;
	abstract?: string;
	year?: number;
	venue?: string;
	externalIds?: {
		ArXiv?: string;
	};
}

interface SemanticScholarSearchResponse {
	data?: SemanticScholarPaper[];
}

function clipSnippet(input: string, maxChars = 320): string {
	const normalized = input.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, maxChars - 1)}…`;
}

function decodeXmlEntities(value: string): string {
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'");
}

function extractXmlTag(entry: string, tagName: string): string | undefined {
	const match = entry.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
	return match ? decodeXmlEntities(match[1].trim()) : undefined;
}

async function searchSemanticScholar(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
	const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
	url.searchParams.set("query", query);
	url.searchParams.set("limit", String(limit));
	url.searchParams.set("fields", "title,url,abstract,year,venue,externalIds");

	const response = await fetch(url, {
		signal,
		headers: {
			accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Semantic Scholar returned ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as SemanticScholarSearchResponse;
	const papers = payload.data ?? [];

	return papers
		.map((paper): WebSearchResult | undefined => {
			const fallbackArxivUrl = paper.externalIds?.ArXiv
				? `https://arxiv.org/abs/${paper.externalIds.ArXiv}`
				: undefined;
			const urlValue = paper.url?.trim() || fallbackArxivUrl;
			if (!urlValue) {
				return undefined;
			}

			const venueYear = [paper.venue, paper.year].filter(Boolean).join(", ");
			const snippet = paper.abstract?.trim() ? paper.abstract : venueYear || "No abstract available.";

			return {
				title: paper.title?.trim() || "Untitled paper",
				url: urlValue,
				snippet: clipSnippet(snippet),
				source: "semantic-scholar",
			};
		})
		.filter((paper): paper is WebSearchResult => paper !== undefined)
		.slice(0, limit);
}

async function searchArxiv(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
	const url = new URL("https://export.arxiv.org/api/query");
	url.searchParams.set("search_query", `all:${query}`);
	url.searchParams.set("start", "0");
	url.searchParams.set("max_results", String(limit));

	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`arXiv returned ${response.status} ${response.statusText}`);
	}

	const xml = await response.text();
	const entryMatches = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
	const results: WebSearchResult[] = [];

	for (const match of entryMatches) {
		const entry = match[1];
		const title = extractXmlTag(entry, "title");
		const paperUrl = extractXmlTag(entry, "id");
		const summary = extractXmlTag(entry, "summary");

		if (!paperUrl) {
			continue;
		}

		results.push({
			title: title || "Untitled arXiv paper",
			url: paperUrl,
			snippet: clipSnippet(summary || "No abstract available."),
			source: "arxiv",
		});
	}

	return results.slice(0, limit);
}

function dedupeResults(results: WebSearchResult[]): WebSearchResult[] {
	const seen = new Set<string>();
	const deduped: WebSearchResult[] = [];

	for (const result of results) {
		if (seen.has(result.url)) {
			continue;
		}
		seen.add(result.url);
		deduped.push(result);
	}

	return deduped;
}

function formatResults(results: WebSearchResult[]): string {
	if (results.length === 0) {
		return "No results found.";
	}

	return results
		.map(
			(result, index) =>
				`${index + 1}. ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}\nSource: ${result.source}`,
		)
		.join("\n\n");
}

export function createWebSearchTool(): AgentTool<typeof webSearchSchema, WebSearchToolDetails> {
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search scholarly sources for related work. Returns ranked results with title, URL, snippet, and source.",
		parameters: webSearchSchema,
		execute: async (_toolCallId: string, params: WebSearchToolInput, signal?: AbortSignal) => {
			const query = params.query.trim();
			if (query.length === 0) {
				throw new Error("Query must not be empty.");
			}

			const limit = params.limit ?? 5;
			const providerErrors: string[] = [];
			let results: WebSearchResult[] = [];

			try {
				results = await searchSemanticScholar(query, limit, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				providerErrors.push(`semantic-scholar: ${message}`);
			}

			if (results.length < limit) {
				try {
					const arxivResults = await searchArxiv(query, limit, signal);
					results = dedupeResults([...results, ...arxivResults]).slice(0, limit);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					providerErrors.push(`arxiv: ${message}`);
				}
			}

			if (results.length === 0) {
				const errorDetail = providerErrors.length > 0 ? ` (${providerErrors.join("; ")})` : "";
				throw new Error(`No search results available${errorDetail}.`);
			}

			return {
				content: [{ type: "text", text: formatResults(results) }],
				details: {
					query,
					results,
					providerErrors: providerErrors.length > 0 ? providerErrors : undefined,
				},
			};
		},
	};
}

export const webSearchTool = createWebSearchTool();
