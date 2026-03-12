# Cartographer Roadmap

## Phase 1: CLI Runner (Implemented)

Non-interactive CLI for running, inspecting, and scaffolding behavior trees from the command line. Structured text and JSON output for observing tree execution.

**Commands:** `cartographer run`, `cartographer inspect`, `cartographer init`

**Status:** In progress

## Phase 2: Interactive TUI Dashboard

Full interactive terminal UI for real-time tree observation and control.

### Planned Features

- **Tree panel** — Live-updating ASCII tree with node status colors (green=SUCCESS, red=FAILURE, yellow=RUNNING)
- **Event log panel** — Scrollable event stream with filtering by event type
- **Blackboard panel** — Real-time view of blackboard key-value pairs
- **Agent detail panel** — Expanded view of agent thinking, tool use, and responses
- **Keyboard shortcuts** — Pause/resume, abort, reset, panel navigation, filter toggles
- **Elicitation UI** — Interactive prompts when MCP servers request user input via onElicitation

### Open Decisions

- **Framework choice: Ink vs Ratatui** — Ink (React-based, stays in Node/TS ecosystem) vs Ratatui (Rust, better performance for large trees, requires IPC bridge). Ink is the likely choice for ecosystem consistency.
- **IPC protocol (if Rust)** — If Ratatui is chosen, need to design a protocol for the Node.js runner process to stream events to the Rust TUI process. JSON over stdio is the simplest option.

## Decisions Log

| Decision        | Choice                               | Rationale                                                            |
| --------------- | ------------------------------------ | -------------------------------------------------------------------- |
| Phased approach | Phase 1 non-interactive, Phase 2 TUI | Validate runner design before committing to TUI framework            |
| User contract   | Factory function → TreeRunConfig     | Allows dynamic construction, closures, full TS type checking         |
| TS loading      | tsx                                  | Already a dependency, fast, handles ESM + TS without pre-compilation |
| Distribution    | Same `cartographer` package          | Simpler for users — one install gets library + CLI                   |
| Arg parsing     | Minimal custom parser                | Command set is small and fixed; no need for yargs/commander weight   |
