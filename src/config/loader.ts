import YAML from 'yaml';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { AgentNode } from '../nodes/agent.js';
import { SelectorNode } from '../composites/selector.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { InverterNode } from '../decorators/inverter.js';
import { RepeatNode } from '../decorators/repeat.js';
import { RetryNode } from '../decorators/retry.js';
import { AlwaysSucceedNode } from '../decorators/always-succeed.js';
import { AlwaysFailNode } from '../decorators/always-fail.js';
import { TimeoutNode } from '../decorators/timeout.js';
import { GuardNode } from '../decorators/guard.js';
import type { BTreeNode } from '../types.js';
import type { TreeRegistry } from './registry.js';

/**
 * Internal shape of a single node entry in the parsed YAML.
 *
 * `type` and `name` are required for every node. Additional fields are
 * specific to each node type (e.g. `ref`, `children`, `child`, `strategy`).
 * The index signature `[key: string]: unknown` allows arbitrary extra fields
 * to be present without TypeScript errors, since YAML parsing is untyped.
 */
interface NodeConfig {
  type: string;
  name: string;
  /** Registry key for action and condition nodes. */
  ref?: string;
  /** Child node definitions for composite nodes (selector, sequence, parallel). */
  children?: NodeConfig[];
  /** Single child node definition for decorator nodes. */
  child?: NodeConfig;
  /**
   * Strategy configuration for composite nodes.
   * Currently only `ref` is used — it resolves to a registered strategy by name.
   */
  strategy?: { type?: string; ref?: string; prompt?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Internal shape of the top-level parsed YAML document.
 */
interface TreeConfig {
  name: string;
  root: NodeConfig;
}

/**
 * Constructs a {@link BehaviorTree} from a YAML string or a pre-parsed config
 * object, resolving node references via a {@link TreeRegistry}.
 *
 * `TreeLoader` is the bridge between declarative YAML tree definitions and
 * executable behavior tree instances. It recursively walks the node config
 * tree, instantiates the appropriate node class for each entry, and wires
 * in action functions, condition functions, schemas, and strategies from the
 * registry.
 *
 * All methods are static — `TreeLoader` is not instantiated.
 *
 * ## YAML format
 *
 * A valid tree document must have a `name` and a single `root` node. Every
 * node requires `type` and `name` fields. Additional fields depend on the
 * node type:
 *
 * ```yaml
 * name: my-tree
 * root:
 *   type: sequence
 *   name: main
 *   children:
 *     # Action node — requires "ref" pointing to a registered action
 *     - type: action
 *       name: fetch-user
 *       ref: fetch-user
 *
 *     # Condition node — requires "ref" pointing to a registered condition
 *     - type: condition
 *       name: is-authenticated
 *       ref: is-authenticated
 *
 *     # Agent node — inline config; "outputSchema" resolves a registered Zod schema
 *     - type: agent
 *       name: classify
 *       mode: structured
 *       prompt: "Classify the user intent"
 *       outputSchema: intent-schema
 *       model: haiku
 *       effort: low
 *       blackboardNamespace: classify
 *
 *     # Selector / Sequence / Parallel — optional strategy.ref
 *     - type: selector
 *       name: get-data
 *       strategy:
 *         ref: adaptive-strategy
 *       children:
 *         - type: action
 *           name: from-cache
 *           ref: from-cache
 *         - type: action
 *           name: from-db
 *           ref: from-db
 *
 *     # Guard — requires "conditionRef" (registered condition) and "child"
 *     - type: guard
 *       name: auth-guard
 *       conditionRef: is-admin
 *       child:
 *         type: action
 *         name: admin-action
 *         ref: admin-action
 *
 *     # Retry — requires "maxAttempts"; "child" and "delayMs" are required/optional
 *     - type: retry
 *       name: with-retry
 *       maxAttempts: 3
 *       delayMs: 500
 *       child:
 *         type: action
 *         name: api-call
 *         ref: api-call
 *
 *     # Repeat — "count" and/or "untilStatus" control termination
 *     - type: repeat
 *       name: poll-loop
 *       count: 10
 *       untilStatus: success
 *       child:
 *         type: action
 *         name: poll
 *         ref: poll
 *
 *     # Timeout — requires "timeoutMs"
 *     - type: timeout
 *       name: time-limited
 *       timeoutMs: 5000
 *       child:
 *         type: action
 *         name: slow-action
 *         ref: slow-action
 *
 *     # Inverter / AlwaysSucceed / AlwaysFail — require "child"
 *     - type: inverter
 *       name: not-ready
 *       child:
 *         type: condition
 *         name: is-ready
 *         ref: is-ready
 * ```
 *
 * ## Supported node types
 *
 * | `type` | Required fields | Optional fields |
 * |---|---|---|
 * | `action` | `ref` | — |
 * | `condition` | `ref` | — |
 * | `agent` | `mode`, `prompt` | `outputSchema`, `model`, `effort`, `allowedTools`, `permissionMode`, `maxTurns`, `maxBudgetUsd`, `systemPrompt`, `blackboardNamespace` |
 * | `selector` | — | `strategy.ref`, `children` |
 * | `sequence` | — | `strategy.ref`, `children` |
 * | `parallel` | — | `strategy.ref`, `children` |
 * | `inverter` | `child` | — |
 * | `repeat` | `child` | `count`, `untilStatus` |
 * | `retry` | `child`, `maxAttempts` | `delayMs` |
 * | `alwaysSucceed` | `child` | — |
 * | `alwaysFail` | `child` | — |
 * | `timeout` | `child`, `timeoutMs` | — |
 * | `guard` | `child`, `conditionRef` | — |
 *
 * @example
 * ```ts
 * const registry = new TreeRegistry();
 * registry.registerAction('fetch-user', fetchUserFn);
 * registry.registerCondition('is-authenticated', isAuthFn);
 *
 * const yaml = `
 * name: my-tree
 * root:
 *   type: sequence
 *   name: root
 *   children:
 *     - type: condition
 *       name: auth-check
 *       ref: is-authenticated
 *     - type: action
 *       name: fetch
 *       ref: fetch-user
 * `;
 *
 * const tree = TreeLoader.fromYAML(yaml, registry);
 * const status = await tree.tick();
 * ```
 */
export class TreeLoader {
  /**
   * Parse a YAML string and construct a {@link BehaviorTree}.
   *
   * The YAML document must be an object with a `name` string and a `root`
   * node definition. Node references in the YAML are resolved against the
   * provided registry.
   *
   * @param yamlString - The YAML tree definition to parse.
   * @param registry - The registry containing action, condition, schema, and
   *   strategy implementations referenced by the YAML.
   *
   * @throws {Error} If the YAML cannot be parsed, or if the parsed object
   *   is missing the required `root` field.
   * @throws {Error} Propagates errors from {@link fromConfig} for invalid
   *   node configurations (missing `ref`, unknown `type`, etc.).
   */
  static fromYAML(yamlString: string, registry: TreeRegistry): BehaviorTree {
    const config = YAML.parse(yamlString);
    if (!config || typeof config !== 'object' || !config.root) {
      throw new Error('Invalid tree config: must have a "root" node');
    }
    return TreeLoader.fromConfig(config as TreeConfig, registry);
  }

  /**
   * Construct a {@link BehaviorTree} from a pre-parsed config object.
   *
   * Useful when the tree definition originates from a source other than YAML
   * (e.g. JSON, a database, or programmatic construction) and has already
   * been parsed into a plain object that matches the expected shape.
   *
   * @param config - The parsed tree configuration with `name` and `root`.
   * @param registry - The registry containing action, condition, schema, and
   *   strategy implementations referenced by the config.
   *
   * @throws {Error} For invalid node configurations — see {@link buildNode}.
   */
  static fromConfig(config: TreeConfig, registry: TreeRegistry): BehaviorTree {
    const root = TreeLoader.buildNode(config.root, registry);
    return new BehaviorTree({ name: config.name, root });
  }

  /**
   * Recursively instantiate a node and all of its descendants from a config object.
   *
   * Dispatches on `config.type` to construct the appropriate node class.
   * Composite nodes (`selector`, `sequence`, `parallel`) recurse into
   * `config.children`. Decorator nodes (`inverter`, `repeat`, `retry`, etc.)
   * recurse into `config.child`. Registry lookups happen here for `ref`,
   * `conditionRef`, `outputSchema`, and `strategy.ref` fields.
   *
   * @throws {Error} If `config.type` is not a recognised node type.
   * @throws {Error} If a required field (`ref`, `child`, `conditionRef`,
   *   `maxAttempts`, `timeoutMs`) is missing for the given node type.
   * @throws {Error} If a registry lookup fails (name not registered).
   */
  private static buildNode(config: NodeConfig, registry: TreeRegistry): BTreeNode {
    switch (config.type) {
      case 'action': {
        if (!config.ref) throw new Error(`Action node "${config.name}" is missing required "ref"`);
        return new ActionNode({
          name: config.name,
          action: registry.getAction(config.ref),
        });
      }

      case 'condition': {
        if (!config.ref) throw new Error(`Condition node "${config.name}" is missing required "ref"`);
        return new ConditionNode({
          name: config.name,
          condition: registry.getCondition(config.ref),
        });
      }

      case 'agent':
        return new AgentNode({
          name: config.name,
          mode: config.mode as 'structured' | 'agentic',
          prompt: config.prompt as string,
          outputSchema: config.outputSchema
            ? registry.getSchema(config.outputSchema as string)
            : undefined,
          model: config.model as any,
          effort: config.effort as any,
          allowedTools: config.allowedTools as string[] | undefined,
          permissionMode: config.permissionMode as any,
          maxTurns: config.maxTurns as number | undefined,
          maxBudgetUsd: config.maxBudgetUsd as number | undefined,
          systemPrompt: config.systemPrompt as string | undefined,
          blackboardNamespace: config.blackboardNamespace as string | undefined,
        });

      case 'selector':
        return new SelectorNode({
          name: config.name,
          children: (config.children ?? []).map((c) => TreeLoader.buildNode(c, registry)),
          strategy: config.strategy?.ref
            ? (registry.getStrategy(config.strategy.ref) as any)
            : undefined,
        });

      case 'sequence':
        return new SequenceNode({
          name: config.name,
          children: (config.children ?? []).map((c) => TreeLoader.buildNode(c, registry)),
          strategy: config.strategy?.ref
            ? (registry.getStrategy(config.strategy.ref) as any)
            : undefined,
        });

      case 'parallel':
        return new ParallelNode({
          name: config.name,
          children: (config.children ?? []).map((c) => TreeLoader.buildNode(c, registry)),
          strategy: config.strategy?.ref
            ? (registry.getStrategy(config.strategy.ref) as any)
            : undefined,
        });

      case 'inverter': {
        if (!config.child) throw new Error(`Inverter node "${config.name}" is missing required "child"`);
        return new InverterNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child, registry),
        });
      }

      case 'repeat': {
        if (!config.child) throw new Error(`Repeat node "${config.name}" is missing required "child"`);
        return new RepeatNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child, registry),
          count: config.count as number | undefined,
          untilStatus: config.untilStatus as any,
        });
      }

      case 'retry': {
        if (!config.child) throw new Error(`Retry node "${config.name}" is missing required "child"`);
        return new RetryNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child, registry),
          maxAttempts: config.maxAttempts as number,
          delayMs: config.delayMs as number | undefined,
        });
      }

      case 'alwaysSucceed': {
        if (!config.child) throw new Error(`AlwaysSucceed node "${config.name}" is missing required "child"`);
        return new AlwaysSucceedNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child, registry),
        });
      }

      case 'alwaysFail': {
        if (!config.child) throw new Error(`AlwaysFail node "${config.name}" is missing required "child"`);
        return new AlwaysFailNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child, registry),
        });
      }

      case 'timeout': {
        if (!config.child) throw new Error(`Timeout node "${config.name}" is missing required "child"`);
        return new TimeoutNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child, registry),
          timeoutMs: config.timeoutMs as number,
        });
      }

      case 'guard': {
        if (!config.child) throw new Error(`Guard node "${config.name}" is missing required "child"`);
        if (!config.conditionRef) throw new Error(`Guard node "${config.name}" is missing required "conditionRef"`);
        return new GuardNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child, registry),
          condition: registry.getCondition(config.conditionRef as string),
        });
      }

      default:
        throw new Error(`Unknown node type: ${config.type}`);
    }
  }
}
