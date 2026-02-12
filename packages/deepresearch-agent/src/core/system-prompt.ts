export const REQUIRED_REPORT_HEADINGS = [
	"# Paper",
	"## 1. Key Problems and Challenges",
	"## 2. How This Paper Solves Them",
	"## 3. Related Work and Key Differences",
	"## 4. Future Directions",
	"## References",
] as const;

export const REQUIRED_QUESTION_HEADINGS = [
	"## 1. Key Problems and Challenges",
	"## 2. How This Paper Solves Them",
	"## 3. Related Work and Key Differences",
	"## 4. Future Directions",
] as const;

export const REPORT_TEMPLATE = `${REQUIRED_REPORT_HEADINGS[0]}
${REQUIRED_REPORT_HEADINGS[1]}

${REQUIRED_REPORT_HEADINGS[2]}

${REQUIRED_REPORT_HEADINGS[3]}

${REQUIRED_REPORT_HEADINGS[4]}

${REQUIRED_REPORT_HEADINGS[5]}
`;

export function buildDeepResearchSystemPrompt(): string {
	return `You are a deep research agent focused on academic paper analysis.

Use tools intentionally and keep the report grounded in cited sources.

Workflow:
1. Start from the provided seed paper URL.
2. Create a report skeleton first with the required headings.
3. Iterate: read report draft -> identify gaps -> search related work -> extract evidence -> write updated report.
4. Stop naturally when no more tool calls are needed.

Hard requirements for the final report:
- Answer these four questions:
  1) Key problems/challenges in the seed paper
  2) How the seed paper solves them
  3) How related work solves similar problems and key differences
  4) Future directions the seed paper does not explore
- Include a References section with valid source URLs.
- Use inline numeric citations like [1], [2], ... and map them in References.

Write concise, factual prose. Preserve provenance and avoid unsupported claims.`;
}

export interface BuildDeepResearchUserPromptOptions {
	seedUrl: string;
	reportPath: string;
	sourcesPath?: string;
}

export function buildDeepResearchUserPrompt(options: BuildDeepResearchUserPromptOptions): string {
	const sourcesInstruction = options.sourcesPath
		? `If you maintain a provenance map, write it to \`${options.sourcesPath}\` in JSON format.`
		: "";

	return `Seed paper URL: ${options.seedUrl}

Work only through the tool interface.

Primary artifact path:
- report markdown: \`${options.reportPath}\`
${sourcesInstruction}

Required report template:
\`\`\`markdown
${REPORT_TEMPLATE.trim()}
\`\`\`

Execution instructions:
1. First call \`write\` to create the initial template at \`${options.reportPath}\`.
2. Use \`web_search\` and \`extract_source\` to gather evidence.
3. Re-read and fully rewrite the report with \`write\` as needed.
4. Ensure references are traceable URLs and inline citations are consistent.
5. Finish when the report is complete and no more tools are needed.`;
}
