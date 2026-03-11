# Behavior Tree Fundamentals

This guide introduces the core concepts behind behavior trees and how Cartographer implements them. It is written for developers who may be encountering behavior trees for the first time, and builds from simple ideas to the full execution model.

---

## What Is a Behavior Tree?

A behavior tree is a hierarchical structure used to model decision-making. Originally popularized in game AI, behavior trees have proven to be a powerful pattern for any system that needs to evaluate conditions, execute actions, and react to changing state.

A behavior tree is composed of **nodes** arranged in a tree. Execution begins at the root and propagates downward through the tree in a process called a **tick**. Each node, when ticked, does some work and returns one of exactly three outcomes. The parent node uses that outcome to decide what to do next.

This tick-based execution model gives behavior trees several appealing properties:

- **Composability.** Small, focused nodes combine into complex behaviors.
- **Readability.** The tree structure makes control flow visible at a glance.
- **Reactivity.** Each tick re-evaluates the tree, allowing the system to respond to new information.
- **Modularity.** Individual nodes can be tested, reused, and rearranged independently.

---

## NodeStatus: The Three Outcomes

Every node in a behavior tree, when ticked, must return exactly one of three statuses:

| Status      | Value       | Meaning                                        |
|-------------|-------------|-------------------------------------------------|
| `SUCCESS`   | `'success'` | The node completed its work successfully.       |
| `FAILURE`   | `'failure'` | The node completed but did not achieve its goal.|
| `RUNNING`   | `'running'` | The node is still working; tick again later.    |

There is no "error" status. If a node throws an exception during execution, Cartographer catches it and returns `FAILURE`. This keeps the tree's control flow predictable: parent nodes always receive one of the three values and can always decide what to do next.

```
NodeStatus.SUCCESS   -- "I did it."
NodeStatus.FAILURE   -- "I couldn't do it."
NodeStatus.RUNNING   -- "I'm still working on it."
```

The `RUNNING` status is what makes behavior trees suitable for asynchronous and long-running work. A node that calls an API, waits for a user response, or delegates to an AI agent can return `RUNNING` to signal that it is not yet finished. When a child returns `RUNNING`, its parent composite (Sequence or Selector) remembers which child was running and resumes from that child on the next tick, skipping siblings that already completed. This means the tree can make incremental progress across multiple ticks without re-executing work that already succeeded.

---

## Node Categories

Every node in a behavior tree falls into one of three categories: **leaf**, **composite**, or **decorator**.

```
                        [Selector]
                       /          \
                [Sequence]      [Action: fallback]
                /        \
        [Condition]  [Action: primary]
```

In this diagram, `Selector` and `Sequence` are composites, `Condition` and both `Action` nodes are leaves. A decorator would wrap a single child node.

### Leaf Nodes

Leaf nodes sit at the bottom of the tree. They do the actual work: checking conditions, running logic, or calling external systems. They have no children.

Cartographer provides three leaf node types:

- **ActionNode** -- Executes arbitrary logic. Your function receives the tree context and returns a `NodeStatus`.
- **ConditionNode** -- Evaluates a boolean check. Returns `SUCCESS` if the condition is true, `FAILURE` if false.
- **AgentNode** -- Delegates work to an AI agent via the Claude SDK. Use `options.outputFormat` to get structured, schema-validated output.

### Composite Nodes

Composite nodes have one or more children and define how those children are ticked. The composite's logic determines which children run, in what order, and how their statuses combine into the composite's own result.

Cartographer provides three composite node types:

- **SelectorNode** -- Ticks children in order until one returns `SUCCESS` or `RUNNING`. If all children return `FAILURE`, the selector returns `FAILURE`. Think of it as an OR gate: "try each option until one works." When a child returns `RUNNING`, the selector remembers that child and resumes from it on the next tick.

- **SequenceNode** -- Ticks children in order until one returns `FAILURE` or `RUNNING`. If all children return `SUCCESS`, the sequence returns `SUCCESS`. Think of it as an AND gate: "do all steps in order; stop if any step fails." When a child returns `RUNNING`, the sequence remembers that child and resumes from it on the next tick, skipping children that already succeeded.

- **ParallelNode** -- Ticks all children concurrently using `Promise.all`. A configurable policy determines how many successes or failures are needed to produce the final result. Useful for running independent tasks simultaneously.

Each composite accepts an optional **strategy** that can reorder children or adjust policy before execution. More on strategies below.

### Decorator Nodes

Decorator nodes wrap exactly one child and modify its behavior or result. They are the behavior tree equivalent of middleware.

Cartographer provides these decorators:

| Decorator          | Behavior                                                     |
|--------------------|--------------------------------------------------------------|
| `InverterNode`     | Flips `SUCCESS` to `FAILURE` and vice versa.                |
| `RepeatNode`       | Ticks the child multiple times or until a target status.     |
| `RetryNode`        | Retries the child on `FAILURE`, up to a maximum attempt count.|
| `AlwaysSucceedNode`| Returns `SUCCESS` regardless of the child's result.          |
| `AlwaysFailNode`   | Returns `FAILURE` regardless of the child's result.          |
| `TimeoutNode`      | Aborts the child and returns `FAILURE` if it exceeds a time limit.|
| `GuardNode`        | Evaluates a condition before ticking the child. Returns `FAILURE` if the guard condition is false.|

---

## The Tick Cycle

A tick is a single top-to-bottom traversal of the tree. Here is what happens when you call `BehaviorTree.tick()`:

```
1. BehaviorTree.tick()
   |
   |  Constructs TreeContext: { blackboard, events, signal }
   |
   v
2. Root node receives tick(context)
   |
   |  BaseNode.tick() emits 'node:enter'
   |  BaseNode.tick() calls execute(context)
   |
   v
3. If composite: asks strategy for child order,
   then ticks children according to its rules
   |
   v
4. If leaf: runs its logic (action, condition, or agent call)
   |
   v
5. Node returns NodeStatus
   |
   |  BaseNode.tick() emits 'node:exit' with { status, durationMs }
   |
   v
6. Parent uses child's status to decide next step
   |
   v
7. Final status bubbles up to BehaviorTree.tick() caller
```

Every node goes through the same `BaseNode.tick()` wrapper, which provides consistent lifecycle events:

1. **Emit `node:enter`** -- signals that this node is about to execute.
2. **Call `execute(context)`** -- the node-specific logic runs.
3. **Emit `node:exit`** -- reports the resulting status and how long execution took.
4. **On error** -- if `execute` throws, an `node:error` event is emitted, `node:exit` fires with `FAILURE`, and `FAILURE` is returned.

This wrapper ensures that every node, regardless of type, participates in the event system and handles errors uniformly.

---

## TreeContext: The Execution Environment

Every node receives a `TreeContext` when it is ticked. The context is the node's window into the outside world:

```
TreeContext {
  blackboard: Blackboard     -- shared key-value state
  events: TypedEventEmitter   -- event bus for lifecycle hooks
  signal?: AbortSignal        -- cooperative cancellation
}
```

- **blackboard** -- The shared state store. Nodes read from and write to the blackboard to communicate without being directly coupled to each other. See the next section for details.

- **events** -- A typed event emitter that carries lifecycle events (`node:enter`, `node:exit`, `node:error`), agent events (`agent:prompt`, `agent:response`, `agent:tool_use`), and system events (`blackboard:write`, `strategy:decision`). You can attach listeners to observe, log, or react to tree execution in real time.

- **signal** -- An optional `AbortSignal` that nodes can check for cooperative cancellation. When `BehaviorTree.abort()` is called, the signal fires, and well-behaved nodes can stop their work early.

The context is constructed fresh on each tick by the `BehaviorTree`, but the blackboard and event emitter persist across ticks. This means state accumulates on the blackboard between ticks while the signal is renewed.

---

## The Blackboard Pattern

The blackboard is a shared key-value store that solves a fundamental problem: how do nodes communicate without knowing about each other?

Consider a sequence where one node fetches data from an API and the next node processes that data. Without a blackboard, you would need to wire these nodes together directly, destroying the modularity that makes behavior trees useful.

With a blackboard, the first node writes its result under a key, and the second node reads from that key:

```
Node A: context.blackboard.set('apiResponse', data)
Node B: context.blackboard.get<ResponseType>('apiResponse')
```

The nodes are completely decoupled. Node A does not know Node B exists. Node B does not know where the data came from. You can rearrange, replace, or test them independently.

The Cartographer blackboard supports:

- **get / set / has / delete** -- Standard key-value operations.
- **keys()** -- List all keys in the store.
- **scoped(namespace)** -- Create a namespaced view. Keys written through a scoped blackboard are prefixed with the namespace, preventing collisions when multiple subsystems share the same blackboard.

---

## Strategies: Pluggable Decision-Making

Every composite node in Cartographer accepts an optional **strategy** that controls how children are ordered or how policies are evaluated. Strategies are the primary extension point for composites.

There are three strategy interfaces, one per composite type:

- **SelectionStrategy** -- Controls the order in which a `SelectorNode` tries its children.
- **ExecutionStrategy** -- Controls the order in which a `SequenceNode` runs its children.
- **ParallelStrategy** -- Determines the success/failure policy for a `ParallelNode`.

The default strategies preserve insertion order and require all children to succeed (for sequences) or one child to succeed (for selectors). But strategies can be swapped at construction time to change behavior without changing tree structure.

---

## Cartographer's Differentiator: Agent Nodes and Agent Strategies

Traditional behavior trees are static: the tree structure and execution order are determined at design time. Cartographer introduces two mechanisms that make behavior trees adaptive at runtime.

### Agent Nodes

An `AgentNode` is a leaf node that delegates its work to an AI agent powered by the Claude SDK. Instead of running a hand-coded function, it sends a prompt to Claude and interprets the response.

Every AgentNode call is an agentic SDK invocation. SDK options are passed directly via the `options` field, giving you access to the full range of Agent SDK capabilities -- models, tools, MCP servers, structured output via `outputFormat`, turn limits, budget caps, and more.

The agent node writes its results to the blackboard, making them available to downstream nodes just like any other data.

### Agent Strategies

An agent strategy replaces a composite's default strategy with one backed by Claude. Instead of using a fixed ordering or policy, the composite describes its children to Claude and asks for a decision.

For example, an agent selection strategy might present a selector's children to Claude along with the current blackboard state and ask: "Given the current context, which of these approaches should we try first?" Claude responds with an ordering, and the selector follows it.

This means the same tree structure can produce different execution paths depending on the runtime context, without any changes to the tree itself. Agent strategies accept configuration including a prompt, model selection, effort level, and descriptions of each child node.

---

## Glossary

**Tick**
A single execution cycle of the behavior tree. Calling `BehaviorTree.tick()` triggers a top-to-bottom traversal where each visited node executes and returns a status.

**Node**
The fundamental unit of a behavior tree. Every node has a unique ID, a name, and a `tick()` method that returns a `NodeStatus`.

**Leaf**
A node with no children. Leaves perform the actual work of the tree: running actions, checking conditions, or calling AI agents.

**Composite**
A node with one or more children. Composites define control flow by deciding which children to tick and how to interpret their results. The three composite types are Selector, Sequence, and Parallel.

**Decorator**
A node that wraps exactly one child and modifies its behavior or result. Examples include inverting a status, retrying on failure, or enforcing a timeout.

**Blackboard**
A shared key-value store passed to every node through the tree context. Nodes use the blackboard to share data without direct coupling.

**Context (TreeContext)**
The execution environment passed to every node on each tick. Contains the blackboard, event emitter, and an optional abort signal.

**Execution Cycle**
A single run of a composite node from start to terminal result. A cycle begins when the composite has no RUNNING child (fresh start) and ends when it returns SUCCESS or FAILURE. Within a cycle, the child order is committed on the first tick and remains stable across subsequent ticks that resume a RUNNING child. Calling `reset()` also ends the current cycle.

**Strategy**
A pluggable component that controls how a composite node orders its children or evaluates its policy. Strategies can be static (fixed rules) or agent-backed (AI-driven decisions).

**Agent Node**
A leaf node that delegates execution to an AI agent via the Claude SDK. Use `options.outputFormat` for structured output, or omit it for free-form interaction.

**Status (NodeStatus)**
The result of ticking a node. One of three values: `SUCCESS`, `FAILURE`, or `RUNNING`.

---

## Where to go next

- [Quick Start](getting-started.md) -- install Cartographer and build your first tree.
- [Building Trees](guide-building-trees.md) -- three construction approaches compared side-by-side.
- [Leaf Nodes](guide-nodes.md) -- ActionNode, ConditionNode, and AgentNode in detail.
