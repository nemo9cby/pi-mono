import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

export interface ResearchStatusMessage {
	role: "researchStatus";
	status: "initialized" | "updated" | "finalized";
	note: string;
	timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		researchStatus: ResearchStatusMessage;
	}
}

function researchStatusToLlmMessage(message: ResearchStatusMessage): Message {
	return {
		role: "user",
		content: [{ type: "text", text: `Research status (${message.status}): ${message.note}` }],
		timestamp: message.timestamp,
	};
}

export function createResearchStatusMessage(
	note: string,
	status: ResearchStatusMessage["status"] = "updated",
	timestamp = Date.now(),
): ResearchStatusMessage {
	return {
		role: "researchStatus",
		status,
		note,
		timestamp,
	};
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((message): Message[] => {
		switch (message.role) {
			case "researchStatus":
				return [researchStatusToLlmMessage(message)];
			case "user":
			case "assistant":
			case "toolResult":
				return [message];
			default: {
				const _exhaustive: never = message;
				return _exhaustive;
			}
		}
	});
}
