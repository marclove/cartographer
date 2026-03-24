import type { SDKMessage, SDKAssistantMessage, SDKResultMessage, SDKSystemMessage, SDKToolProgressMessage, SDKRateLimitEvent } from '@anthropic-ai/claude-agent-sdk';
import type { AgentMessage } from './agent.js';

/**
 * Map a single SDK message to one or more provider-agnostic {@link AgentMessage} values.
 *
 * The SDK uses a discriminated union of message types. This function translates
 * each variant into the framework's own message types:
 *
 * - `assistant` → one message per content block (`thinking`, `text`, `tool_use`)
 * - `result` → a single `result` message with `success` or `error` subtype.
 *   For success results, structured output is preferred over raw text; raw text
 *   is JSON-parsed as a fallback.
 * - `stream_event` → a semantic `stream` message with the raw event
 * - `system` → a `provider_event` with subtype `init` or `status`
 * - `tool_progress` → a `provider_event` with normalized field names
 * - `rate_limit_event` → a `provider_event` wrapping rate limit info
 * - All other SDK types → a `provider_event` pass-through with the raw message
 *
 * @param msg - A single message from the SDK's async iterable.
 * @returns An array of zero or more mapped messages. The array may contain
 *   multiple entries for `assistant` messages with several content blocks.
 */
export function mapSdkMessage(msg: SDKMessage): AgentMessage[] {
  const messages: AgentMessage[] = [];

  switch (msg.type) {
    case 'assistant': {
      const assistant = msg as SDKAssistantMessage;
      for (const block of assistant.message.content) {
        if (block.type === 'thinking') {
          messages.push({ type: 'thinking', content: block.thinking });
        } else if (block.type === 'text') {
          messages.push({ type: 'text', content: block.text });
        } else if (block.type === 'tool_use') {
          messages.push({ type: 'tool_use', name: block.name, input: block.input });
        }
      }
      break;
    }

    case 'result': {
      const result = msg as SDKResultMessage;
      if (result.subtype === 'success') {
        let output: unknown = result.result;
        if (result.structured_output !== undefined) {
          output = result.structured_output;
        } else if (typeof result.result === 'string') {
          try { output = JSON.parse(result.result); } catch { output = result.result; }
        }
        messages.push({
          type: 'result',
          subtype: 'success',
          output,
          cost: result.total_cost_usd,
        });
      } else {
        messages.push({
          type: 'result',
          subtype: 'error',
          errors: result.errors,
          cost: result.total_cost_usd,
        });
      }
      break;
    }

    case 'system': {
      const sys = msg as SDKSystemMessage;
      messages.push({
        type: 'provider_event',
        subtype: sys.subtype === 'init' ? 'init' : 'status',
        data: sys,
      });
      break;
    }

    default: {
      // Provider-specific events — use the SDK's discriminated types
      if ('type' in msg) {
        const m = msg as Record<string, unknown>;
        if (m.type === 'stream_event') {
          messages.push({ type: 'stream', event: msg });
        } else if (m.type === 'tool_progress') {
          const tp = msg as SDKToolProgressMessage;
          messages.push({
            type: 'provider_event',
            subtype: 'tool_progress',
            data: { toolUseId: tp.tool_use_id, toolName: tp.tool_name, elapsedSeconds: tp.elapsed_time_seconds },
          });
        } else if (m.type === 'rate_limit_event') {
          const rl = msg as SDKRateLimitEvent;
          messages.push({ type: 'provider_event', subtype: 'rate_limit', data: { info: rl.rate_limit_info } });
        } else {
          // All other SDK message types pass through as provider events
          messages.push({ type: 'provider_event', subtype: String(m.type), data: msg });
        }
      }
      break;
    }
  }

  return messages;
}
