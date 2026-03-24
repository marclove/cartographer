import type { OnElicitation } from './agent.js';
import type { BTreeNode, TreeContext, TreeEvents, TypedEventEmitter, AgentStrategyConfig } from '../types.js';

/**
 * Wrap an optional elicitation handler so callers always receive a function.
 *
 * Used by the three agent strategies to ensure consistent elicitation
 * behaviour across all agent calls. If a user-provided handler exists
 * it is called directly; otherwise the wrapper emits an
 * `agent:elicitation_declined` event and returns `{ action: 'decline' }`.
 *
 * @param handler - The resolved elicitation handler, or `undefined` if none
 *   was provided at any level.
 * @param node - The node associated with the agent call. Used in the
 *   `agent:elicitation_declined` event payload.
 * @param events - The tree's event emitter, used to emit
 *   `agent:elicitation_declined` when no handler exists.
 * @returns An {@link OnElicitation} function safe to pass to `Agent.send()`.
 */
export function wrapElicitation(
  handler: OnElicitation | undefined,
  node: BTreeNode,
  events: TypedEventEmitter<TreeEvents>,
): OnElicitation {
  return async (request, options) => {
    if (handler) return handler(request, options);
    events.emit('agent:elicitation_declined', { node, request });
    return { action: 'decline' as const };
  };
}

/**
 * Build the full prompt string that agent strategies send to the agent.
 *
 * Combines the caller's base prompt with two contextual sections — the
 * list of available child nodes and a snapshot of the current blackboard
 * state — so the agent has everything it needs to make an informed decision.
 *
 * **Prompt resolution:** The `config.prompt` value can be either a static
 * string or a function `(children, context) => string` for dynamic prompt
 * construction. In both cases, the child and blackboard sections are
 * appended automatically.
 *
 * The returned string has the following structure:
 *
 * ```
 * {resolved basePrompt}
 *
 * Available children:
 * [{ "name": "childA", "description": "..." }, ...]
 *
 * Blackboard state:
 * { "key": value, ... }
 * ```
 *
 * @param config - The strategy config, providing the base prompt and
 *   optional `childDescriptions` map.
 * @param children - The child nodes whose names and descriptions are
 *   included in the prompt's "Available children" section.
 * @param context - The tree context, used to read the current blackboard
 *   state and (when `prompt` is a function) passed to the prompt builder.
 * @returns The composite prompt string ready to send to the agent.
 */
export function buildStrategyPrompt(
  config: AgentStrategyConfig,
  children: BTreeNode[],
  context: TreeContext,
): string {
  const basePrompt = typeof config.prompt === 'function'
    ? config.prompt(children, context)
    : config.prompt;

  const childInfo = children.map((c) => ({
    name: c.name,
    description: config.childDescriptions?.[c.name] ?? c.name,
  }));

  const blackboardState: Record<string, unknown> = {};
  for (const key of context.blackboard.keys()) {
    blackboardState[key] = context.blackboard.get(key);
  }

  return `${basePrompt}\n\nAvailable children:\n${JSON.stringify(childInfo, null, 2)}\n\nBlackboard state:\n${JSON.stringify(blackboardState, null, 2)}`;
}
