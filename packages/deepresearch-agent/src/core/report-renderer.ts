function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderInline(markdown: string): string {
	let html = escapeHtml(markdown);
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(
		/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
		'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
	);
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	return html;
}

function isBlockBoundary(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0) return true;
	if (/^#{1,6}\s+/.test(trimmed)) return true;
	if (/^```/.test(trimmed)) return true;
	if (/^>\s?/.test(trimmed)) return true;
	if (/^\d+\.\s+/.test(trimmed)) return true;
	if (/^[-*]\s+/.test(trimmed)) return true;
	return false;
}

function renderMarkdownToHtml(markdown: string): string {
	const lines = markdown.replaceAll("\r\n", "\n").split("\n");
	const blocks: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		const trimmed = line.trim();

		if (trimmed.length === 0) {
			index += 1;
			continue;
		}

		const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			const level = headingMatch[1].length;
			blocks.push(`<h${level}>${renderInline(headingMatch[2].trim())}</h${level}>`);
			index += 1;
			continue;
		}

		if (trimmed.startsWith("```")) {
			const language = trimmed.slice(3).trim();
			const codeLines: string[] = [];
			index += 1;
			while (index < lines.length && !lines[index].trim().startsWith("```")) {
				codeLines.push(lines[index]);
				index += 1;
			}
			if (index < lines.length) {
				index += 1;
			}
			const className = language.length > 0 ? ` class="language-${escapeHtml(language)}"` : "";
			blocks.push(`<pre><code${className}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
			continue;
		}

		if (/^\d+\.\s+/.test(trimmed)) {
			const items: string[] = [];
			while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
				items.push(lines[index].trim().replace(/^\d+\.\s+/, ""));
				index += 1;
			}
			blocks.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`);
			continue;
		}

		if (/^[-*]\s+/.test(trimmed)) {
			const items: string[] = [];
			while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
				items.push(lines[index].trim().replace(/^[-*]\s+/, ""));
				index += 1;
			}
			blocks.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
			continue;
		}

		if (/^>\s?/.test(trimmed)) {
			const quoteLines: string[] = [];
			while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
				quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
				index += 1;
			}
			blocks.push(`<blockquote>${renderMarkdownToHtml(quoteLines.join("\n"))}</blockquote>`);
			continue;
		}

		const paragraphLines: string[] = [trimmed];
		index += 1;
		while (index < lines.length && !isBlockBoundary(lines[index])) {
			paragraphLines.push(lines[index].trim());
			index += 1;
		}
		blocks.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`);
	}

	return blocks.join("\n");
}

const DEFAULT_STYLES = `
:root {
	color-scheme: light;
	font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
}
body {
	margin: 0;
	padding: 2rem;
	background: #f6f8fb;
	color: #1f2937;
}
main {
	max-width: 900px;
	margin: 0 auto;
	padding: 2rem;
	background: #ffffff;
	border: 1px solid #e5e7eb;
	border-radius: 12px;
}
h1, h2, h3, h4, h5, h6 {
	color: #0f172a;
}
pre {
	background: #0f172a;
	color: #e2e8f0;
	padding: 1rem;
	overflow: auto;
	border-radius: 8px;
}
code {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
	background: #eef2ff;
	padding: 0.1rem 0.3rem;
	border-radius: 4px;
}
a {
	color: #1d4ed8;
	text-decoration: none;
}
a:hover {
	text-decoration: underline;
}
blockquote {
	margin: 0;
	padding: 0.5rem 1rem;
	border-left: 3px solid #94a3b8;
	background: #f8fafc;
}
`;

export interface RenderReportHtmlOptions {
	title?: string;
	styles?: string;
}

export function renderReportHtml(markdown: string, options: RenderReportHtmlOptions = {}): string {
	const title = options.title ?? "Deep Research Report";
	const bodyHtml = renderMarkdownToHtml(markdown);
	const styles = options.styles ?? DEFAULT_STYLES;

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${escapeHtml(title)}</title>
	<style>
${styles}
	</style>
</head>
<body>
	<main>
${bodyHtml}
	</main>
</body>
</html>`;
}
