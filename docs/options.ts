/**
 * Options for the query function.
 * Contains callbacks and other non-serializable fields.
 *
 * This is copied from the SDK codebase for easy quick reference during development.
 * DO NOT modify this file ever!!!
 *
 * [Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/typescript#options)
 */
export declare type Options = {
    /**
     * Controller for cancelling the query. When aborted, the query will stop
     * and clean up resources.
     */
    abortController?: AbortController;
    /**
     * Additional directories Claude can access beyond the current working directory.
     * Paths should be absolute.
     */
    additionalDirectories?: string[];
    /**
     * Agent name for the main thread. When specified, the agent's system prompt,
     * tool restrictions, and model will be applied to the main conversation.
     * The agent must be defined either in the `agents` option or in settings.
     *
     * This is equivalent to the `--agent` CLI flag.
     *
     * @example
     * ```typescript
     * agent: 'code-reviewer',
     * agents: {
     *   'code-reviewer': {
     *     description: 'Reviews code for best practices',
     *     prompt: 'You are a code reviewer...'
     *   }
     * }
     * ```
     */
    agent?: string;
    /**
     * Programmatically define custom subagents that can be invoked via the Agent tool.
     * Keys are agent names, values are agent definitions.
     *
     * @example
     * ```typescript
     * agents: {
     *   'test-runner': {
     *     description: 'Runs tests and reports results',
     *     prompt: 'You are a test runner...',
     *     tools: ['Read', 'Grep', 'Glob', 'Bash']
     *   }
     * }
     * ```
     */
    agents?: Record<string, AgentDefinition>;
    /**
     * List of tool names that are auto-allowed without prompting for permission.
     * These tools will execute automatically without asking the user for approval.
     * To restrict which tools are available, use the `tools` option instead.
     */
    allowedTools?: string[];
    /**
     * Custom permission handler for controlling tool usage. Called before each
     * tool execution to determine if it should be allowed, denied, or prompt the user.
     */
    canUseTool?: CanUseTool;
    /**
     * Continue the most recent conversation in the current directory instead of starting a new one.
     * Mutually exclusive with `resume`.
     */
    continue?: boolean;
    /**
     * Current working directory for the session. Defaults to `process.cwd()`.
     */
    cwd?: string;
    /**
     * List of tool names that are disallowed. These tools will be removed
     * from the model's context and cannot be used, even if they would
     * otherwise be allowed.
     */
    disallowedTools?: string[];
    /**
     * Specify the base set of available built-in tools.
     * - `string[]` - Array of specific tool names (e.g., `['Bash', 'Read', 'Edit']`)
     * - `[]` (empty array) - Disable all built-in tools
     * - `{ type: 'preset'; preset: 'claude_code' }` - Use all default Claude Code tools
     */
    tools?: string[] | {
        type: 'preset';
        preset: 'claude_code';
    };
    /**
     * Environment variables to pass to the Claude Code process.
     * Defaults to `process.env`.
     *
     * SDK consumers can identify their app/library to include in the User-Agent header by setting:
     * - `CLAUDE_AGENT_SDK_CLIENT_APP` - Your app/library identifier (e.g., "my-app/1.0.0", "my-library/2.1")
     *
     * @example
     * ```typescript
     * env: { CLAUDE_AGENT_SDK_CLIENT_APP: 'my-app/1.0.0' }
     * ```
     */
    env?: {
        [envVar: string]: string | undefined;
    };
    /**
     * JavaScript runtime to use for executing Claude Code.
     * Auto-detected if not specified.
     */
    executable?: 'bun' | 'deno' | 'node';
    /**
     * Additional arguments to pass to the JavaScript runtime executable.
     */
    executableArgs?: string[];
    /**
     * Additional CLI arguments to pass to Claude Code.
     * Keys are argument names (without --), values are argument values.
     * Use `null` for boolean flags.
     */
    extraArgs?: Record<string, string | null>;
    /**
     * Fallback model to use if the primary model fails or is unavailable.
     */
    fallbackModel?: string;
    /**
     * Enable file checkpointing to track file changes during the session.
     * When enabled, files can be rewound to their state at any user message
     * using `Query.rewindFiles()`.
     *
     * File checkpointing creates backups of files before they are modified,
     * allowing you to restore them to previous states.
     */
    enableFileCheckpointing?: boolean;
    /**
     * Per-tool configuration for built-in tools.
     *
     * @example
     * ```typescript
     * toolConfig: {
     *   askUserQuestion: { previewFormat: 'html' }
     * }
     * ```
     */
    toolConfig?: ToolConfig;
    /**
     * When true, resumed sessions will fork to a new session ID rather than
     * continuing the previous session. Use with `resume`.
     */
    forkSession?: boolean;
    /**
     * Enable beta features. Currently supported:
     * - `'context-1m-2025-08-07'` - Enable 1M token context window (Sonnet 4/4.5 only)
     *
     * @see https://docs.anthropic.com/en/api/beta-headers
     */
    betas?: SdkBeta[];
    /**
     * Hook callbacks for responding to various events during execution.
     * Hooks can modify behavior, add context, or implement custom logic.
     *
     * @example
     * ```typescript
     * hooks: {
     *   PreToolUse: [{
     *     hooks: [async (input) => ({ continue: true })]
     *   }]
     * }
     * ```
     */
    hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    /**
     * Callback for handling MCP elicitation requests.
     * Called when an MCP server requests user input (form fields, URL auth, etc.)
     * and no hook handles the request first.
     *
     * If not provided, elicitation requests that aren't handled by hooks will
     * be declined automatically.
     *
     * @example
     * ```typescript
     * onElicitation: async (request) => {
     *   if (request.mode === 'url') {
     *     // Handle URL-based auth
     *     return { action: 'accept' }
     *   }
     *   // Provide form values
     *   return { action: 'accept', content: { name: 'Test' } }
     * }
     * ```
     */
    onElicitation?: OnElicitation;
    /**
     * When false, disables session persistence to disk. Sessions will not be
     * saved to ~/.claude/projects/ and cannot be resumed later. Useful for
     * ephemeral or automated workflows where session history is not needed.
     *
     * @default true
     */
    persistSession?: boolean;
    /**
     * Include partial/streaming message events in the output.
     * When true, `SDKPartialAssistantMessage` events will be emitted during streaming.
     */
    includePartialMessages?: boolean;
    /**
     * Controls Claude's thinking/reasoning behavior.
     *
     * - `{ type: 'adaptive' }` — Claude decides when and how much to think (Opus 4.6+).
     *   This is the default for models that support it.
     * - `{ type: 'enabled', budgetTokens: number }` — Fixed thinking token budget (older models)
     * - `{ type: 'disabled' }` — No extended thinking
     *
     * When set, takes precedence over the deprecated `maxThinkingTokens`.
     *
     * @see https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking
     */
    thinking?: ThinkingConfig;
    /**
     * Controls how much effort Claude puts into its response.
     * Works with adaptive thinking to guide thinking depth.
     *
     * - `'low'` — Minimal thinking, fastest responses
     * - `'medium'` — Moderate thinking
     * - `'high'` — Deep reasoning (default)
     * - `'max'` — Maximum effort (Opus 4.6 only)
     *
     * @see https://docs.anthropic.com/en/docs/build-with-claude/effort
     */
    effort?: 'low' | 'medium' | 'high' | 'max';
    /**
     * Maximum number of tokens the model can use for its thinking/reasoning process.
     * Helps control cost and latency for complex tasks.
     *
     * @deprecated Use `thinking` instead. On Opus 4.6, this is treated as on/off
     * (0 = disabled, any other value = adaptive). For explicit control, use
     * `thinking: { type: 'adaptive' }` or `thinking: { type: 'enabled', budgetTokens: N }`.
     */
    maxThinkingTokens?: number;
    /**
     * Maximum number of conversation turns before the query stops.
     * A turn consists of a user message and assistant response.
     */
    maxTurns?: number;
    /**
     * Maximum budget in USD for the query. The query will stop if this
     * budget is exceeded, returning an `error_max_budget_usd` result.
     */
    maxBudgetUsd?: number;
    /**
     * MCP (Model Context Protocol) server configurations.
     * Keys are server names, values are server configurations.
     *
     * @example
     * ```typescript
     * mcpServers: {
     *   'my-server': {
     *     command: 'node',
     *     args: ['./my-mcp-server.js']
     *   }
     * }
     * ```
     */
    mcpServers?: Record<string, McpServerConfig>;
    /**
     * Claude model to use. Defaults to the CLI default model.
     * Examples: 'claude-sonnet-4-6', 'claude-opus-4-6'
     */
    model?: string;
    /**
     * Output format configuration for structured responses.
     * When specified, the agent will return structured data matching the schema.
     *
     * @example
     * ```typescript
     * outputFormat: {
     *   type: 'json_schema',
     *   schema: { type: 'object', properties: { result: { type: 'string' } } }
     * }
     * ```
     */
    outputFormat?: OutputFormat;
    /**
     * Path to the Claude Code executable. Uses the built-in executable if not specified.
     */
    pathToClaudeCodeExecutable?: string;
    /**
     * Permission mode for the session.
     * - `'default'` - Standard permission behavior, prompts for dangerous operations
     * - `'acceptEdits'` - Auto-accept file edit operations
     * - `'bypassPermissions'` - Bypass all permission checks (requires `allowDangerouslySkipPermissions`)
     * - `'plan'` - Planning mode, no execution of tools
     * - `'dontAsk'` - Don't prompt for permissions, deny if not pre-approved
     */
    permissionMode?: PermissionMode;
    /**
     * Must be set to `true` when using `permissionMode: 'bypassPermissions'`.
     * This is a safety measure to ensure intentional bypassing of permissions.
     */
    allowDangerouslySkipPermissions?: boolean;
    /**
     * MCP tool name to use for permission prompts. When set, permission requests
     * will be routed through this MCP tool instead of the default handler.
     */
    permissionPromptToolName?: string;
    /**
     * Load plugins for this session. Plugins provide custom commands, agents,
     * skills, and hooks that extend Claude Code's capabilities.
     *
     * Currently only local plugins are supported via the 'local' type.
     *
     * @example
     * ```typescript
     * plugins: [
     *   { type: 'local', path: './my-plugin' },
     *   { type: 'local', path: '/absolute/path/to/plugin' }
     * ]
     * ```
     */
    plugins?: SdkPluginConfig[];



    /**
     * Enable prompt suggestions. When true, the agent emits a `prompt_suggestion`
     * message after each turn with a predicted next user prompt.
     *
     * Delivery semantics:
     * - At most one `prompt_suggestion` per turn; arrives after the `result` message.
     * - Consumers must keep iterating the stream after `result` to receive it.
     * - Suppressed on the first turn, after API errors, in plan mode, and by the
     *   `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` env var.
     * - Suggestions piggyback on the parent's prompt cache, making them nearly free.
     */
    promptSuggestions?: boolean;
    /**
     * Session ID to resume. Loads the conversation history from the specified session.
     */
    resume?: string;
    /**
     * Use a specific session ID for the conversation instead of an auto-generated one.
     * Must be a valid UUID. Cannot be used with `continue` or `resume` unless
     * `forkSession` is also set (to specify a custom ID for the forked session).
     */
    sessionId?: string;
    /**
     * When resuming, only resume messages up to and including the message with this UUID.
     * Use with `resume`. This allows you to resume from a specific point in the conversation.
     * The message ID should be from `SDKAssistantMessage.uuid`.
     */
    resumeSessionAt?: string;
    /**
     * Sandbox settings for command execution isolation.
     *
     * When enabled, commands are executed in a sandboxed environment that restricts
     * filesystem and network access. This provides an additional security layer.
     *
     * **Important:** Filesystem and network restrictions are configured via permission
     * rules, not via these sandbox settings:
     * - Filesystem access: Use `Read` and `Edit` permission rules
     * - Network access: Use `WebFetch` permission rules
     *
     * These sandbox settings control sandbox behavior (enabled, auto-allow, etc.),
     * while the actual access restrictions come from your permission configuration.
     *
     * @example Enable sandboxing with auto-allow
     * ```typescript
     * sandbox: {
     *   enabled: true,
     *   autoAllowBashIfSandboxed: true
     * }
     * ```
     *
     * @example Configure network options (not restrictions)
     * ```typescript
     * sandbox: {
     *   enabled: true,
     *   network: {
     *     allowLocalBinding: true,
     *     allowUnixSockets: ['/var/run/docker.sock']
     *   }
     * }
     * ```
     *
     * @see https://docs.anthropic.com/en/docs/claude-code/settings#sandbox-settings
     */
    sandbox?: SandboxSettings;
    /**
     * Additional settings to apply. Accepts either a path to a settings JSON file
     * or a settings object. These are loaded into the "flag settings" layer,
     * which has the highest priority among user-controlled settings.
     *
     * Equivalent to the `--settings` CLI flag.
     *
     * @example Inline settings object
     * ```typescript
     * settings: { model: 'claude-sonnet-4-6', permissions: { allow: ['Bash(*)'] } }
     * ```
     *
     * @example Path to settings file
     * ```typescript
     * settings: '/path/to/settings.json'
     * ```
     */
    settings?: string | Settings;
    /**
     * Control which filesystem settings to load.
     * - `'user'` - Global user settings (`~/.claude/settings.json`)
     * - `'project'` - Project settings (`.claude/settings.json`)
     * - `'local'` - Local settings (`.claude/settings.local.json`)
     *
     * When omitted or empty, no filesystem settings are loaded (SDK isolation mode).
     * Must include `'project'` to load CLAUDE.md files.
     */
    settingSources?: SettingSource[];
    /**
     * Enable debug mode for the Claude Code process.
     * When true, enables verbose debug logging (equivalent to `--debug` CLI flag).
     * Debug logs are written to a file (see `debugFile` option) or to stderr.
     *
     * You can also capture debug output via the `stderr` callback.
     */
    debug?: boolean;
    /**
     * Write debug logs to a specific file path.
     * Implicitly enables debug mode. Equivalent to `--debug-file <path>` CLI flag.
     */
    debugFile?: string;
    /**
     * Callback for stderr output from the Claude Code process.
     * Useful for debugging and logging.
     */
    stderr?: (data: string) => void;
    /**
     * Enforce strict validation of MCP server configurations.
     * When true, invalid configurations will cause errors instead of warnings.
     */
    strictMcpConfig?: boolean;
    /**
     * System prompt configuration.
     * - `string` - Use a custom system prompt
     * - `{ type: 'preset', preset: 'claude_code' }` - Use Claude Code's default system prompt
     * - `{ type: 'preset', preset: 'claude_code', append: '...' }` - Use default prompt with appended instructions
     *
     * @example Custom prompt
     * ```typescript
     * systemPrompt: 'You are a helpful coding assistant.'
     * ```
     *
     * @example Default with additions
     * ```typescript
     * systemPrompt: {
     *   type: 'preset',
     *   preset: 'claude_code',
     *   append: 'Always explain your reasoning.'
     * }
     * ```
     */
    systemPrompt?: string | {
        type: 'preset';
        preset: 'claude_code';
        append?: string;
    };
    /**
     * Custom function to spawn the Claude Code process.
     * Use this to run Claude Code in VMs, containers, or remote environments.
     *
     * When provided, this function is called instead of the default local spawn.
     * The default behavior checks if the executable exists before spawning.
     *
     * @example
     * ```typescript
     * spawnClaudeCodeProcess: (options) => {
     *   // Custom spawn logic for VM execution
     *   // options contains: command, args, cwd, env, signal
     *   return myVMProcess; // Must satisfy SpawnedProcess interface
     * }
     * ```
     */
    spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
};
