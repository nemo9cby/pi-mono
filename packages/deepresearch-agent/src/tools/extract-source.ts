import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

const MAX_ABSTRACT_CHARS = 1_500;
const MAX_FULL_TEXT_CHARS = 30_000;

const extractSourceSchema = Type.Object({
	url: Type.String({ minLength: 1, description: "Source URL to extract from (arXiv, PDF, HTML, or other)" }),
});

export type ExtractSourceToolInput = Static<typeof extractSourceSchema>;
export type SourceType = "arxiv" | "pdf" | "html" | "other";

export interface ExtractSourceToolDetails {
	title: string;
	authors?: string[];
	year?: number;
	abstract?: string;
	fullText?: string;
	sourceType: SourceType;
	canonicalUrl: string;
	missingFields: string[];
}

function decodeEntities(value: string): string {
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'");
}

function normalizeWhitespace(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

function clipText(input: string, maxChars: number): string {
	if (input.length <= maxChars) {
		return input;
	}
	return `${input.slice(0, maxChars - 1)}…`;
}

function extractXmlTag(entry: string, tagName: string): string | undefined {
	const match = entry.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
	return match ? decodeEntities(normalizeWhitespace(match[1])) : undefined;
}

function parseArxivId(url: URL): string | undefined {
	if (!url.hostname.endsWith("arxiv.org")) {
		return undefined;
	}

	const absMatch = url.pathname.match(/^\/abs\/([^/?#]+)/);
	if (absMatch) {
		return absMatch[1];
	}

	const pdfMatch = url.pathname.match(/^\/pdf\/([^/?#]+?)(?:\.pdf)?$/);
	if (pdfMatch) {
		return pdfMatch[1];
	}

	return undefined;
}

function classifySourceType(url: URL, contentType: string | null): SourceType {
	const normalizedContentType = (contentType ?? "").toLowerCase();
	const path = url.pathname.toLowerCase();

	if (url.hostname.endsWith("arxiv.org")) {
		return "arxiv";
	}
	if (path.endsWith(".pdf") || normalizedContentType.includes("application/pdf")) {
		return "pdf";
	}
	if (
		path.endsWith(".html") ||
		path.endsWith(".htm") ||
		normalizedContentType.includes("text/html") ||
		normalizedContentType.includes("application/xhtml+xml")
	) {
		return "html";
	}
	return "other";
}

function guessTitleFromUrl(url: URL): string {
	const pathPart = url.pathname.split("/").filter(Boolean).at(-1);
	if (!pathPart) {
		return url.hostname;
	}
	return decodeURIComponent(pathPart).replace(/[-_]+/g, " ");
}

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMetaContent(html: string, key: string): string | undefined {
	const escapedKey = escapeRegExp(key);
	const directMatch = html.match(
		new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${escapedKey}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
	);
	if (directMatch) {
		return decodeEntities(normalizeWhitespace(directMatch[1]));
	}

	const reverseMatch = html.match(
		new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escapedKey}["'][^>]*>`, "i"),
	);
	if (reverseMatch) {
		return decodeEntities(normalizeWhitespace(reverseMatch[1]));
	}

	return undefined;
}

function extractMetaValues(html: string, key: string): string[] {
	const escapedKey = escapeRegExp(key);
	const matches = [
		...html.matchAll(
			new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${escapedKey}["'][^>]*content=["']([^"']+)["'][^>]*>`, "gi"),
		),
		...html.matchAll(
			new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escapedKey}["'][^>]*>`, "gi"),
		),
	];

	return matches
		.map((match) => decodeEntities(normalizeWhitespace(match[1])))
		.filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
}

function extractHtmlTitle(html: string): string | undefined {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!titleMatch) {
		return undefined;
	}
	return decodeEntities(normalizeWhitespace(titleMatch[1]));
}

function stripHtmlToText(html: string): string {
	const withoutScript = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

	const textOnly = withoutScript.replace(/<[^>]+>/g, " ");
	return decodeEntities(normalizeWhitespace(textOnly));
}

function parseYear(input: string | undefined): number | undefined {
	if (!input) {
		return undefined;
	}
	const match = input.match(/\b(19|20)\d{2}\b/);
	if (!match) {
		return undefined;
	}
	return Number.parseInt(match[0], 10);
}

async function fetchReadableMirror(url: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const response = await fetch(`https://r.jina.ai/${url}`, { signal });
		if (!response.ok) {
			return undefined;
		}
		const text = normalizeWhitespace(await response.text());
		if (text.length === 0) {
			return undefined;
		}
		return clipText(text, MAX_FULL_TEXT_CHARS);
	} catch {
		return undefined;
	}
}

async function extractArxivSource(arxivId: string, signal?: AbortSignal): Promise<ExtractSourceToolDetails> {
	const apiUrl = new URL("https://export.arxiv.org/api/query");
	apiUrl.searchParams.set("id_list", arxivId);

	const response = await fetch(apiUrl, { signal });
	if (!response.ok) {
		throw new Error(`arXiv extraction failed: ${response.status} ${response.statusText}`);
	}

	const xml = await response.text();
	const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
	if (!entryMatch) {
		throw new Error("No arXiv entry found for that URL.");
	}

	const entry = entryMatch[1];
	const canonicalUrl = `https://arxiv.org/abs/${arxivId}`;
	const title = extractXmlTag(entry, "title") || `arXiv:${arxivId}`;
	const abstract = clipText(extractXmlTag(entry, "summary") || "", MAX_ABSTRACT_CHARS) || undefined;
	const published = extractXmlTag(entry, "published");
	const year = parseYear(published);
	const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g)]
		.map((match) => decodeEntities(normalizeWhitespace(match[1])))
		.filter((author) => author.length > 0);
	const fullText = await fetchReadableMirror(canonicalUrl, signal);

	const details: ExtractSourceToolDetails = {
		title,
		authors: authors.length > 0 ? authors : undefined,
		year,
		abstract,
		fullText,
		sourceType: "arxiv",
		canonicalUrl,
		missingFields: [],
	};
	details.missingFields = getMissingFields(details);
	return details;
}

async function extractGenericSource(inputUrl: URL, signal?: AbortSignal): Promise<ExtractSourceToolDetails> {
	const response = await fetch(inputUrl, {
		signal,
		redirect: "follow",
		headers: {
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
	});

	if (!response.ok) {
		throw new Error(`Source extraction failed: ${response.status} ${response.statusText}`);
	}

	const canonicalUrl = response.url;
	const canonical = new URL(canonicalUrl);
	const sourceType = classifySourceType(canonical, response.headers.get("content-type"));

	let title = guessTitleFromUrl(canonical);
	let authors: string[] | undefined;
	let year: number | undefined;
	let abstract: string | undefined;
	let fullText: string | undefined;

	if (sourceType === "html" || sourceType === "other") {
		const html = await response.text();
		title = extractHtmlTitle(html) || extractMetaContent(html, "og:title") || title;

		const citationAuthors = extractMetaValues(html, "citation_author");
		authors = citationAuthors.length > 0 ? citationAuthors : undefined;

		year =
			parseYear(extractMetaContent(html, "citation_publication_date")) ||
			parseYear(extractMetaContent(html, "article:published_time")) ||
			parseYear(extractMetaContent(html, "dc.date"));

		abstract =
			extractMetaContent(html, "citation_abstract") ||
			extractMetaContent(html, "description") ||
			extractMetaContent(html, "og:description");
		if (abstract) {
			abstract = clipText(abstract, MAX_ABSTRACT_CHARS);
		}

		const stripped = stripHtmlToText(html);
		fullText = stripped.length > 0 ? clipText(stripped, MAX_FULL_TEXT_CHARS) : undefined;
	} else if (sourceType === "pdf") {
		fullText = await fetchReadableMirror(canonicalUrl, signal);
	}

	if (!abstract && fullText) {
		abstract = clipText(fullText, MAX_ABSTRACT_CHARS);
	}

	if (!fullText) {
		fullText = await fetchReadableMirror(canonicalUrl, signal);
	}

	const details: ExtractSourceToolDetails = {
		title,
		authors,
		year,
		abstract,
		fullText,
		sourceType,
		canonicalUrl,
		missingFields: [],
	};
	details.missingFields = getMissingFields(details);
	return details;
}

function getMissingFields(details: ExtractSourceToolDetails): string[] {
	const missing: string[] = [];
	if (!details.authors || details.authors.length === 0) {
		missing.push("authors");
	}
	if (!details.year) {
		missing.push("year");
	}
	if (!details.abstract) {
		missing.push("abstract");
	}
	if (!details.fullText) {
		missing.push("fullText");
	}
	return missing;
}

function formatExtractedSource(details: ExtractSourceToolDetails): string {
	const blocks: string[] = [];
	blocks.push(`Title: ${details.title}`);
	blocks.push(`Canonical URL: ${details.canonicalUrl}`);
	blocks.push(`Source type: ${details.sourceType}`);
	if (details.authors && details.authors.length > 0) {
		blocks.push(`Authors: ${details.authors.join(", ")}`);
	}
	if (details.year) {
		blocks.push(`Year: ${details.year}`);
	}
	if (details.abstract) {
		blocks.push(`Abstract:\n${details.abstract}`);
	}
	if (details.fullText) {
		blocks.push(`Full text:\n${details.fullText}`);
	}
	if (details.missingFields.length > 0) {
		blocks.push(`Missing fields: ${details.missingFields.join(", ")}`);
	}
	return blocks.join("\n\n");
}

export function createExtractSourceTool(): AgentTool<typeof extractSourceSchema, ExtractSourceToolDetails> {
	return {
		name: "extract_source",
		label: "extract_source",
		description:
			"Extract normalized metadata and text from a source URL. Supports arXiv metadata path and generic HTML/PDF extraction.",
		parameters: extractSourceSchema,
		execute: async (_toolCallId: string, params: ExtractSourceToolInput, signal?: AbortSignal) => {
			const normalizedInput = params.url.trim();
			if (normalizedInput.length === 0) {
				throw new Error("URL must not be empty.");
			}

			let url: URL;
			try {
				url = new URL(normalizedInput);
			} catch {
				throw new Error(`Invalid URL: ${normalizedInput}`);
			}

			const arxivId = parseArxivId(url);
			const details = arxivId ? await extractArxivSource(arxivId, signal) : await extractGenericSource(url, signal);

			return {
				content: [{ type: "text", text: formatExtractedSource(details) }],
				details,
			};
		},
	};
}

export const extractSourceTool = createExtractSourceTool();
