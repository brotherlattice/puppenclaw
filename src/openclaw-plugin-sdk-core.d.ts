declare module "openclaw/plugin-sdk/core" {
  export const DEFAULT_ACCOUNT_ID: string;

  export interface PluginLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug(message: string): void;
  }

  export interface PluginRuntime {}

  export interface GatewayRequestHandlerOptions {
    params?: unknown;
    respond(ok: boolean, result?: unknown, error?: { message: string; code?: string }): void;
  }

  export interface OpenClawPluginToolContext {
    messageChannel?: string;
    requesterSenderId?: string;
  }

  export interface AgentToolResult {
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }

  export interface AnyAgentTool {
    name: string;
    label?: string;
    description?: string;
    parameters: unknown;
    displaySummary?: string;
    execute(toolCallId: string, rawParams: unknown): Promise<AgentToolResult>;
  }

  export interface PluginConversationBinding {
    bindingId: string;
    channel: string;
    accountId?: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number;
  }

  export type PluginConversationBindingRequestResult =
    | {
        status: "bound";
        binding: PluginConversationBinding;
      }
    | {
        status: "pending";
        reply: {
          text: string;
        };
      }
    | {
        status: "rejected";
        message: string;
      };

  export interface PluginCommandContext {
    args?: string;
    channel: string;
    channelId?: string;
    requestConversationBinding(input: {
      summary: string;
      detachHint?: string;
    }): Promise<PluginConversationBindingRequestResult>;
    detachConversationBinding(): Promise<{ removed: boolean }>;
    getCurrentConversationBinding(): Promise<PluginConversationBinding | null>;
  }

  export interface OpenClawPluginServiceContext {
    stateDir: string;
    logger: PluginLogger;
  }

  export interface OpenClawPluginService {
    id: string;
    start(context: OpenClawPluginServiceContext): Promise<void> | void;
    stop?(): Promise<void> | void;
  }

  export interface OpenClawPluginCommand {
    name: string;
    description?: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler(context: PluginCommandContext): Promise<{ text: string }> | { text: string };
  }

  export interface OpenClawPluginApi {
    runtime: PluginRuntime;
    logger: PluginLogger;
    config: unknown;
    pluginConfig?: unknown;
    resolvePath?: (input: string) => string;
    registerTool(provider: (toolCtx: OpenClawPluginToolContext) => AnyAgentTool[]): void;
    registerCommand(command: OpenClawPluginCommand): void;
    registerService(service: OpenClawPluginService): void;
    registerGatewayMethod?(method: string, handler: (opts: GatewayRequestHandlerOptions) => Promise<void> | void): void;
  }

  export interface OpenClawPluginDefinition {
    id: string;
    name: string;
    description: string;
    configSchema: unknown;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry(definition: OpenClawPluginDefinition): OpenClawPluginDefinition;
}
