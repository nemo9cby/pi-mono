import type { AgentTool } from "@mariozechner/pi-agent-core";

export {
	createExtractSourceTool,
	type ExtractSourceToolDetails,
	type ExtractSourceToolInput,
	extractSourceTool,
	type SourceType,
} from "./extract-source.js";
export { resolvePathWithinRoot, toPromptPath } from "./path-utils.js";
export { createReadTool, type ReadToolDetails, type ReadToolInput, readTool } from "./read.js";
export {
	createWebSearchTool,
	type WebSearchResult,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	webSearchTool,
} from "./web-search.js";
export { createWriteTool, type WriteToolDetails, type WriteToolInput, writeTool } from "./write.js";

import { createExtractSourceTool } from "./extract-source.js";
import { createReadTool } from "./read.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";

export function createDeepResearchTools(rootDir: string): AgentTool<any, any>[] {
	return [createWebSearchTool(), createExtractSourceTool(), createReadTool(rootDir), createWriteTool(rootDir)];
}
