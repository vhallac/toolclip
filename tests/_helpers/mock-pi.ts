/**
 * Mock pi `ExtensionAPI` for toolclip tests.
 *
 * Captures event handlers and tool registrations in plain Maps so tests
 * can invoke them with hand-crafted events. Mirrors just enough of the
 * real `ExtensionAPI` surface for the extension entrypoint to load.
 */

export type Handler = (event: unknown, ctx: unknown) => unknown;
export type ToolReg = {
	name: string;
	execute: (toolCallId: string, params: unknown) => unknown;
};

export interface MockApi {
	handlers: Map<string, Handler[]>;
	tools: Map<string, ToolReg>;
	pi: Record<string, unknown>;
}

export function createMockApi(): MockApi {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolReg>();
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerTool(tool: ToolReg) {
			tools.set(tool.name, tool);
		},
	};
	return { handlers, tools, pi };
}

/**
 * Invoke the last-registered handler for an event name. Returns `undefined`
 * when no handler is registered — matching how the real extension layer
 * would treat a missing handler.
 */
export function invokeHandler(
	handlers: Map<string, Handler[]>,
	eventName: string,
	event: unknown,
	ctx: unknown = {},
): unknown {
	const h = handlers.get(eventName);
	if (!h || h.length === 0) {
		return undefined;
	}
	return h[h.length - 1](event, ctx);
}

export async function invokeTool(
	tools: Map<string, ToolReg>,
	name: string,
	toolCallId: string,
	params: unknown,
): Promise<unknown> {
	const tool = tools.get(name);
	if (!tool) {
		throw new Error(`Tool "${name}" not registered`);
	}
	return tool.execute(toolCallId, params);
}
