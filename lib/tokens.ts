export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens in an array of LLM messages.
 * Handles both string content and content-block arrays.
 */
export function estimateMessagesTokens(messages: readonly unknown[]): number {
	let total = 0;
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			total += estimateTokens(content);
			continue;
		}

		if (!Array.isArray(content)) {
			continue;
		}

		for (const block of content) {
			if (typeof block === "string") {
				total += estimateTokens(block);
				continue;
			}
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") {
				total += estimateTokens(text);
			}
		}
	}
	return total;
}