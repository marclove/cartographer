import type { Options, OnElicitation as SDKOnElicitation } from '@anthropic-ai/claude-agent-sdk';
import type { Blackboard } from '../types.js';
import type { AgentConfig, AgentSendOptions, AgentElicitationRequest, OnElicitation } from './agent.js';
import { createBlackboardMcpServer } from './blackboard-mcp.js';

/**
 * Configuration for a ClaudeSDKAgent.
 * Flat intersection of AgentConfig and SDK Options — all SDK options
 * sit at the top level alongside `name`.
 */
export type ClaudeSDKAgentConfig = AgentConfig & Partial<Options>;

/**
 * Inject the built-in blackboard MCP server into the SDK option maps.
 *
 * Returns new objects — the input `mcpServers` and `allowedTools` are
 * never mutated.
 *
 * @param mcpServers - Existing MCP servers from the agent config.
 * @param allowedTools - Existing allowed tools from the agent config.
 * @param blackboard - The blackboard to expose via MCP.
 * @param namespace - Optional namespace for scoped access.
 */
export function injectBlackboardMcp(
  mcpServers: Record<string, unknown>,
  allowedTools: string[],
  blackboard: Blackboard,
  namespace?: string,
): { mcpServers: Record<string, unknown>; allowedTools: string[] } {
  return {
    mcpServers: {
      ...mcpServers,
      blackboard: createBlackboardMcpServer(blackboard, namespace),
    },
    allowedTools: [...allowedTools, 'mcp__blackboard__*'],
  };
}

/**
 * Build an SDK-compatible elicitation handler from the framework's
 * {@link OnElicitation} handler.
 *
 * Always returns a handler so the SDK never hangs waiting for interactive
 * input. When no user handler is provided, the handler auto-declines.
 * Framework `cancel` is mapped to SDK `decline`.
 *
 * @param handler - Optional framework elicitation handler.
 */
export function buildSdkElicitationHandler(handler?: OnElicitation): SDKOnElicitation {
  return async (request, opts) => {
    const elicitationRequest: AgentElicitationRequest = {
      message: request.message,
      ...(request.requestedSchema && { schema: request.requestedSchema as Record<string, unknown> }),
      ...(request.serverName && { serverName: request.serverName }),
      ...(request.mode && { mode: request.mode }),
      ...(request.url && { url: request.url }),
      ...(request.elicitationId && { elicitationId: request.elicitationId }),
    };
    if (handler) {
      const response = await handler(elicitationRequest, { signal: opts.signal });
      if (response.action === 'cancel') return { action: 'decline' as const };
      return response;
    }
    return { action: 'decline' as const };
  };
}

/**
 * Resolve the SDK `outputFormat` from config and per-call send options.
 *
 * Two asymmetric paths:
 * - `sendOptionsSchema` always destructures `$schema` (the caller is
 *   providing a raw JSON Schema which commonly includes the meta-schema URI).
 * - `configFormat` only strips `$schema` when the property is actually present
 *   inside the nested `schema` object.
 *
 * `sendOptionsSchema` wins when both are provided.
 *
 * @param configFormat - The `outputFormat` from the agent config.
 * @param sendOptionsSchema - The `outputSchema` from per-call send options.
 */
export function buildSdkOutputFormat(
  configFormat?: Options['outputFormat'],
  sendOptionsSchema?: Record<string, unknown>,
): Options['outputFormat'] | undefined {
  if (sendOptionsSchema) {
    const { $schema, ...schema } = sendOptionsSchema;
    return { type: 'json_schema', schema } as any;
  }

  if (configFormat && 'schema' in configFormat) {
    const { $schema, ...schema } = (configFormat as any).schema as Record<string, unknown>;
    if ($schema) {
      return { ...configFormat, schema } as typeof configFormat;
    }
  }

  return configFormat;
}

/**
 * Compose the full SDK options object from agent config and per-call
 * send options.
 *
 * Orchestrates {@link injectBlackboardMcp}, {@link buildSdkElicitationHandler},
 * and {@link buildSdkOutputFormat} into a single options record suitable for
 * passing to the SDK `query()` call.
 *
 * @param config - The full agent config (name + SDK options).
 * @param sendOptions - Per-invocation send options.
 */
export function composeSdkOptions(
  config: ClaudeSDKAgentConfig,
  sendOptions?: AgentSendOptions,
): Record<string, unknown> {
  const { name: _name, ...sdkConfig } = config;
  const userOptions = sdkConfig as Partial<Options>;

  let mcpServers: Record<string, unknown> = { ...userOptions.mcpServers };
  let allowedTools = [...(userOptions.allowedTools ?? [])];

  if (sendOptions?.blackboard) {
    const injected = injectBlackboardMcp(
      mcpServers,
      allowedTools,
      sendOptions.blackboard,
      sendOptions.blackboardNamespace,
    );
    mcpServers = injected.mcpServers;
    allowedTools = injected.allowedTools;
  }

  const onElicitation = buildSdkElicitationHandler(sendOptions?.onElicitation);
  const outputFormat = buildSdkOutputFormat(userOptions.outputFormat, sendOptions?.outputSchema);

  const {
    onElicitation: _e,
    mcpServers: _m,
    allowedTools: _a,
    outputFormat: _o,
    ...restOptions
  } = userOptions;

  return {
    ...restOptions,
    mcpServers,
    allowedTools,
    permissionMode: restOptions.permissionMode ?? 'default',
    ...(outputFormat && { outputFormat }),
    onElicitation,
    ...(sendOptions?.signal && { signal: sendOptions.signal }),
  };
}
