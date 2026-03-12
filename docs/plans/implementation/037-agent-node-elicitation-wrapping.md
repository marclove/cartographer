# Task 37: AgentNode Elicitation Wrapping

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `AgentNode` always provide a wrapped `onElicitation` callback to the SDK. The wrapper delegates to the resolved handler (node-level > context-level) or emits `agent:elicitation_declined` and declines.

**Depends on:** Task 36

---

### Step 1: Write failing tests

Add tests to `src/nodes/agent.test.ts`. These tests mock the SDK `query()` function to capture the options it receives and invoke the `onElicitation` callback directly.

**Mocking approach:** The existing agent tests likely already mock `query()` as an async generator. Extend that mock to capture the `onElicitation` option from the call arguments:

```typescript
import { vi } from 'vitest';

// Mock the SDK module
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(query);
```

For tests that need to invoke the `onElicitation` callback, set up the mock to:
1. Capture the options from the call
2. Invoke `options.onElicitation` with a test request
3. Return a success result via the async iterable

```typescript
describe('onElicitation wrapping', () => {
  const testRequest = {
    serverName: 'test-server',
    message: 'Please provide credentials',
    mode: 'form' as const,
    requestedSchema: { type: 'object', properties: { api_key: { type: 'string' } } },
  };

  it('delegates to context.onElicitation when no node-level handler is set', async () => {
    const contextHandler = vi.fn().mockResolvedValue({ action: 'accept', content: { api_key: 'sk-123' } });

    // Mock query to invoke onElicitation and return success
    mockQuery.mockImplementation(async function* (args: any) {
      const handler = args.options.onElicitation;
      if (handler) {
        await handler(testRequest, { signal: new AbortController().signal });
      }
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
    });

    const node = new AgentNode({ name: 'test', prompt: 'test' });
    const context = createContext();
    context.onElicitation = contextHandler;

    await node.tick(context);

    expect(contextHandler).toHaveBeenCalledWith(testRequest, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('prefers node-level options.onElicitation over context.onElicitation', async () => {
    const nodeHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const contextHandler = vi.fn().mockResolvedValue({ action: 'accept' });

    mockQuery.mockImplementation(async function* (args: any) {
      await args.options.onElicitation(testRequest, { signal: new AbortController().signal });
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
    });

    const node = new AgentNode({ name: 'test', prompt: 'test', options: { onElicitation: nodeHandler } });
    const context = createContext();
    context.onElicitation = contextHandler;

    await node.tick(context);

    expect(nodeHandler).toHaveBeenCalled();
    expect(contextHandler).not.toHaveBeenCalled();
  });

  it('emits agent:elicitation_declined when no handler exists', async () => {
    let capturedResult: any;
    mockQuery.mockImplementation(async function* (args: any) {
      capturedResult = await args.options.onElicitation(testRequest, { signal: new AbortController().signal });
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
    });

    const node = new AgentNode({ name: 'test', prompt: 'test' });
    const context = createContext();
    const declineSpy = vi.fn();
    context.events.on('agent:elicitation_declined', declineSpy);

    await node.tick(context);

    expect(declineSpy).toHaveBeenCalledWith({
      node,
      request: testRequest,
    });
    expect(capturedResult).toEqual({ action: 'decline' });
  });

  it('always provides onElicitation to the SDK options', async () => {
    let capturedOptions: any;
    mockQuery.mockImplementation(async function* (args: any) {
      capturedOptions = args.options;
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
    });

    const node = new AgentNode({ name: 'test', prompt: 'test' });
    await node.tick(createContext());

    expect(capturedOptions.onElicitation).toBeTypeOf('function');
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/nodes/agent.test.ts`
Expected: FAIL — current AgentNode does not set `onElicitation` on the SDK options.

### Step 3: Implement wrapping in AgentNode.execute()

Edit `src/nodes/agent.ts`:

1. Import `ElicitationRequest` type:

```typescript
import type { AgentNodeConfig, TreeContext, ElicitationRequest } from '../types.js';
```

(Or import directly from the SDK if not re-exported from types yet.)

2. In `execute()`, after resolving `userOptions`, build the wrapped callback:

```typescript
// Resolve elicitation handler: node-level > context-level > decline with event
const userElicitationHandler = userOptions.onElicitation ?? context.onElicitation;

const wrappedOnElicitation = async (
  request: ElicitationRequest,
  opts: { signal: AbortSignal },
) => {
  if (userElicitationHandler) {
    return userElicitationHandler(request, opts);
  }
  context.events.emit('agent:elicitation_declined', {
    node: this,
    request,
  });
  return { action: 'decline' as const };
};
```

3. Strip `onElicitation` from userOptions before spreading, and add the wrapper:

```typescript
const { onElicitation: _nodeElicitation, ...restUserOptions } = userOptions;

const options: Record<string, unknown> = {
  ...restUserOptions,
  mcpServers,
  allowedTools,
  permissionMode: restUserOptions.permissionMode ?? 'default',
  ...(outputFormat && { outputFormat }),
  abortController,
  onElicitation: wrappedOnElicitation,
};
```

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/nodes/agent.test.ts`
Expected: PASS (all tests including new elicitation tests)

### Step 5: Run full test suite

Run: `npm run typecheck && npm run test`
Expected: All pass.

### Step 6: Commit

```bash
git add src/nodes/agent.ts src/nodes/agent.test.ts
git commit -m "feat: wrap onElicitation in AgentNode with decline event fallback"
```
