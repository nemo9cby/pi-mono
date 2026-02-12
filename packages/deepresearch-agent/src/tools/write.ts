import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolvePathWithinRoot } from "./path-utils.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative to project root or absolute)" }),
	content: Type.String({ description: "Text content to write" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
	path: string;
	bytesWritten: number;
}

export function createWriteTool(rootDir: string): AgentTool<typeof writeSchema, WriteToolDetails> {
	return {
		name: "write",
		label: "write",
		description:
			"Create or overwrite a file. Parent directories are created automatically. Use this for iterative report updates.",
		parameters: writeSchema,
		execute: async (_toolCallId: string, params: WriteToolInput) => {
			const absolutePath = resolvePathWithinRoot(params.path, rootDir);
			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, params.content, "utf-8");

			return {
				content: [{ type: "text", text: `Wrote ${params.content.length} characters to ${params.path}` }],
				details: {
					path: params.path,
					bytesWritten: Buffer.byteLength(params.content, "utf-8"),
				},
			};
		},
	};
}

export const writeTool = createWriteTool(process.cwd());
