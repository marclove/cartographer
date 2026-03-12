# Cartographer Roadmap

## Elicitation Support

### Phase 1: Passthrough Elicitation (Current)

Allow `AgentNode` to accept and forward `onElicitation` callbacks so that MCP servers requiring user input (OAuth flows, form fields, credentials) are not silently declined. Users provide their own handler via the programmatic API. Includes context layering infrastructure in `BaseNode` for per-subtree handler inheritance, and `agent:elicitation_declined` event emission when no handler is present.

### Phase 1.5: Agent Strategy Elicitation

Agent strategies (`AgentSelectionStrategy`, `AgentExecutionStrategy`, `AgentParallelStrategy`) also call the SDK's `query()` but do not currently participate in elicitation wrapping. Extend the same wrapping pattern to strategies so that elicitation requests during strategy execution are handled consistently with `AgentNode`.

### Phase 2: Tree-Aware Elicitation

Surface elicitation requests through the tree's event system and/or blackboard so that the orchestrator, other nodes, or external systems (Slack, Telegram, SMS, custom UIs) can observe and react to them. This enables patterns like pausing the tree while waiting for human input, logging elicitation activity, and routing requests to the appropriate channel.

### Phase 3: Automated Elicitation

Allow the tree itself to answer elicitation requests programmatically using blackboard data or dedicated resolver nodes. This enables fully unattended flows where, for example, an MCP server asks for an API key and the tree supplies it from the blackboard without human involvement.
