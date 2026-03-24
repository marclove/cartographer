# Task 162: Extract `mapSdkMessage` into `claude-sdk-mapper.ts`

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the `mapSdkMessage` private method from `ClaudeSDKAgent` into a standalone pure function in a new file, with dedicated unit tests.

**Spec Reference:** `docs/superpowers/specs/2026-03-24-claude-sdk-agent-decomposition-design.md`

**Depends on:** Nothing

---

### Important: Read these files first

- `packages/cartographer/src/agent/claude-sdk-agent.ts` — the `mapSdkMessage()` method (lines 353-433)
- `packages/cartographer/src/agent/claude-sdk-agent.test.ts` — existing tests and mock patterns
- `packages/cartographer/src/agent/agent.ts` — `AgentMessage` type definitions

Understand the SDK type imports used by `mapSdkMessage`: `SDKMessage`, `SDKAssistantMessage`, `SDKResultMessage`, `SDKSystemMessage`, `SDKToolProgressMessage`, `SDKRateLimitEvent`.

---

### Step 1: Write failing tests for `mapSdkMessage`

Create `packages/cartographer/src/agent/claude-sdk-mapper.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapSdkMessage } from './claude-sdk-mapper.js';

describe('mapSdkMessage', () => {
  describe('assistant messages', () => {
    it('maps thinking content blocks', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'reasoning here' }] },
      } as any);

      expect(result).toEqual([{ type: 'thinking', content: 'reasoning here' }]);
    });

    it('maps text content blocks', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      } as any);

      expect(result).toEqual([{ type: 'text', content: 'hello' }]);
    });

    it('maps tool_use content blocks', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'read', input: { path: '/tmp' } }] },
      } as any);

      expect(result).toEqual([{ type: 'tool_use', name: 'read', input: { path: '/tmp' } }]);
    });

    it('maps multiple content blocks from a single assistant message', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'let me think' },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', name: 'edit', input: {} },
          ],
        },
      } as any);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'thinking', content: 'let me think' });
      expect(result[1]).toEqual({ type: 'text', content: 'hello' });
      expect(result[2]).toEqual({ type: 'tool_use', name: 'edit', input: {} });
    });

    it('skips unknown content block types', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'unknown_block_type' }] },
      } as any);

      expect(result).toEqual([]);
    });
  });

  describe('result messages', () => {
    it('maps success result with structured_output', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'success',
        result: 'raw text',
        structured_output: { answer: 42 },
        total_cost_usd: 0.01,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'success',
        output: { answer: 42 },
        cost: 0.01,
      }]);
    });

    it('JSON-parses result string when structured_output is absent', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'success',
        result: '{"answer":42}',
        total_cost_usd: 0.005,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'success',
        output: { answer: 42 },
        cost: 0.005,
      }]);
    });

    it('uses raw string result when JSON parse fails', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'success',
        result: 'just plain text',
        total_cost_usd: 0,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'success',
        output: 'just plain text',
        cost: 0,
      }]);
    });

    it('uses raw result when result is not a string', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'success',
        result: 123,
        total_cost_usd: 0,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'success',
        output: 123,
        cost: 0,
      }]);
    });

    it('maps error result', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'error',
        errors: ['something went wrong'],
        total_cost_usd: 0.01,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'error',
        errors: ['something went wrong'],
        cost: 0.01,
      }]);
    });
  });

  describe('system messages', () => {
    it('maps system init to provider_event with subtype init', () => {
      const msg = { type: 'system', subtype: 'init', session_id: 's1' };
      const result = mapSdkMessage(msg as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'init',
        data: msg,
      }]);
    });

    it('maps system status to provider_event with subtype status', () => {
      const msg = { type: 'system', subtype: 'status', message: 'running' };
      const result = mapSdkMessage(msg as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'status',
        data: msg,
      }]);
    });
  });

  describe('default branch (stream_event, tool_progress, rate_limit, unknown)', () => {
    it('maps stream_event to semantic stream type', () => {
      const msg = { type: 'stream_event', event: { delta: 'hi' } };
      const result = mapSdkMessage(msg as any);

      expect(result).toEqual([{ type: 'stream', event: msg }]);
    });

    it('maps tool_progress with normalized field names', () => {
      const result = mapSdkMessage({
        type: 'tool_progress',
        tool_use_id: 't1',
        tool_name: 'read',
        elapsed_time_seconds: 5,
      } as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'tool_progress',
        data: { toolUseId: 't1', toolName: 'read', elapsedSeconds: 5 },
      }]);
    });

    it('maps rate_limit_event', () => {
      const result = mapSdkMessage({
        type: 'rate_limit_event',
        rate_limit_info: { retryAfter: 5 },
      } as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'rate_limit',
        data: { info: { retryAfter: 5 } },
      }]);
    });

    it('passes unknown SDK message types through as provider_event', () => {
      const msg = { type: 'some_new_sdk_type', data: 'whatever' };
      const result = mapSdkMessage(msg as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'some_new_sdk_type',
        data: msg,
      }]);
    });
  });
});
```

- [ ] **Step 1a: Run test to verify it fails**

Run: `pnpm --filter cartographer exec vitest run src/agent/claude-sdk-mapper.test.ts`

Expected: FAIL — module `./claude-sdk-mapper.js` does not exist.

---

### Step 2: Create `claude-sdk-mapper.ts` with the extracted function

Create `packages/cartographer/src/agent/claude-sdk-mapper.ts`.

Copy the `mapSdkMessage` method body verbatim from `claude-sdk-agent.ts` lines 353-433, converting it from a private method to an exported free function. The SDK type imports come along with it.

```ts
import type { SDKMessage, SDKAssistantMessage, SDKResultMessage, SDKSystemMessage, SDKToolProgressMessage, SDKRateLimitEvent } from '@anthropic-ai/claude-agent-sdk';
import type { AgentMessage } from './agent.js';

/**
 * Map a single SDK message to one or more provider-agnostic AgentMessage values.
 *
 * The SDK uses a discriminated union of message types. This function translates
 * each variant into the framework's own message types. See the AgentMessage
 * type definition for the full set of possible output types.
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
          messages.push({ type: 'provider_event', subtype: String(m.type), data: msg });
        }
      }
      break;
    }
  }

  return messages;
}
```

- [ ] **Step 2a: Run the new tests to verify they pass**

Run: `pnpm --filter cartographer exec vitest run src/agent/claude-sdk-mapper.test.ts`

Expected: All pass.

---

### Step 3: Update `ClaudeSDKAgent` to import the extracted function

In `packages/cartographer/src/agent/claude-sdk-agent.ts`:

1. Add import: `import { mapSdkMessage } from './claude-sdk-mapper.js';`
2. Remove the `private mapSdkMessage(msg: SDKMessage): AgentMessage[]` method (lines 333-433, including JSDoc).
3. Remove SDK type imports that are no longer needed in the class: `SDKAssistantMessage`, `SDKResultMessage`, `SDKToolProgressMessage`, `SDKRateLimitEvent`. Keep `SDKSystemMessage` — it is still used in `_createSendIterator` (line 203: `const sys = msg as SDKSystemMessage` to access `sys.session_id`).
4. In `_createSendIterator`, the calls to `this.mapSdkMessage(msg)` become `mapSdkMessage(msg)`.

- [ ] **Step 3a: Run existing tests to verify nothing broke**

Run: `pnpm --filter cartographer exec vitest run src/agent/claude-sdk-agent.test.ts`

Expected: All pass — behavior is identical.

- [ ] **Step 3b: Run full package tests**

Run: `pnpm --filter cartographer test`

Expected: All pass.

- [ ] **Step 3c: Typecheck**

Run: `pnpm typecheck`

Expected: Clean.

---

### Step 4: Commit

```bash
git add packages/cartographer/src/agent/claude-sdk-mapper.ts \
       packages/cartographer/src/agent/claude-sdk-mapper.test.ts \
       packages/cartographer/src/agent/claude-sdk-agent.ts
git commit -m "refactor(agent): extract mapSdkMessage into claude-sdk-mapper.ts"
```
