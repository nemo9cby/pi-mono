import { readFile } from "node:fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import { resolvePathWithinRoot } from "./path-utils.js";

const MAX_OUTPUT_CHARS = 60_000;

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative to project root or absolute)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start at (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	path: string;
	bytes: number;
	totalLines: number;
	startLine: number;
	endLine: number;
	truncated: boolean;
}

function clipText(input: string, maxChars: number): { content: string; truncated: boolean } {
	if (input.length <= maxChars) {
		return { content: input, truncated: false };
	}
	return { content: input.slice(0, maxChars), truncated: true };
}

export function createReadTool(rootDir: string): AgentTool<typeof readSchema, ReadToolDetails> {
	return {
		name: "read",
		label: "read",
		description:
			"Read file content from disk. Returns text content and metadata. Supports optional offset/limit for line ranges.",
		parameters: readSchema,
		execute: async (_toolCallId: string, params: ReadToolInput) => {
			const absolutePath = resolvePathWithinRoot(params.path, rootDir);
			const rawContent = await readFile(absolutePath, "utf-8");
			const allLines = rawContent.length > 0 ? rawContent.split("\n") : [];
			const totalLines = allLines.length;

			if (totalLines === 0) {
				const emptyContent: TextContent = { type: "text", text: "" };
				return {
					content: [emptyContent],
					details: {
						path: params.path,
						bytes: 0,
						totalLines: 0,
						startLine: 0,
						endLine: 0,
						truncated: false,
					},
				};
			}

			const startLine = Math.max(1, params.offset ?? 1);
			if (startLine > totalLines) {
				throw new Error(`Offset ${startLine} is beyond end of file (${totalLines} lines).`);
			}

			const endLine = params.limit ? Math.min(totalLines, startLine + params.limit - 1) : totalLines;
			const selectedContent = allLines.slice(startLine - 1, endLine).join("\n");
			const clipped = clipText(selectedContent, MAX_OUTPUT_CHARS);

			let outputText = clipped.content;
			if (clipped.truncated) {
				outputText += `\n\n[Output truncated to ${MAX_OUTPUT_CHARS} characters.]`;
			}
			if (endLine < totalLines) {
				outputText += `\n\n[More content available. Continue with offset=${endLine + 1}.]`;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details: {
					path: params.path,
					bytes: Buffer.byteLength(rawContent, "utf-8"),
					totalLines,
					startLine,
					endLine,
					truncated: clipped.truncated,
				},
			};
		},
	};
}

export const readTool = createReadTool(process.cwd());
