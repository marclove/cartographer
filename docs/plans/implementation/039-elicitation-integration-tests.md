# Task 39: Elicitation Integration Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** End-to-end integration tests verifying that elicitation handlers are correctly inherited through the tree via context layering, and that the decline event fires when no handler is present.

**Depends on:** Tasks 35, 36, 37, 38

---

### Mocking approach

The SDK's `query()` returns an async iterable of messages. Elicitation callbacks are invoked by the SDK internally during execution — our code never calls `onElicitation` directly. To test the wrapping behavior end-to-end without hitting the live SDK, mock `query()` to:

1. Capture the `options` argument (including the wrapped `onElicitation`)
2. Invoke `options.onElicitation` with a synthetic `ElicitationRequest`
3. Yield a success result message

```typescript
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(query);

const testRequest = {
  serverName: 'test-mcp-server',
  message: 'Please authenticate',
  mode: 'form' as const,
  requestedSchema: { type: 'object', properties: { token: { type: 'string' } } },
};

function setupMockQuery() {
  mockQuery.mockImplementation(async function* (args: any) {
    const handler = args.options.onElicitation;
    if (handler) {
      await handler(testRequest, { signal: new AbortController().signal });
    }
    yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
  });
}
```

### Step 1: Create integration test file

Create `src/__integration__/elicitation.test.ts`:

```typescript
describe('Elicitation integration', () => {
  beforeEach(() => {
    setupMockQuery();
  });

  it('tree-level onElicitation is inherited by AgentNodes', async () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept', content: { token: 'abc' } });

    const tree = new TreeBuilder('test')
      .onElicitation(handler)
      .sequence('root', (b) => {
        b.agent('worker', { prompt: 'do work' });
      })
      .build();

    await tree.tick();

    expect(handler).toHaveBeenCalledWith(
      testRequest,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('subtree context override takes precedence over tree-level', async () => {
    const treeHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const subtreeHandler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .onElicitation(treeHandler)
      .sequence('root', (b) => {
        b.sequence('scoped', { context: { onElicitation: subtreeHandler } }, (b) => {
          b.agent('inner-agent', { prompt: 'inner work' });
        });
      })
      .build();

    await tree.tick();

    expect(subtreeHandler).toHaveBeenCalled();
    expect(treeHandler).not.toHaveBeenCalled();
  });

  it('emits agent:elicitation_declined when no handler exists at any level', async () => {
    const tree = new TreeBuilder('test')
      .sequence('root', (b) => {
        b.agent('worker', { prompt: 'do work' });
      })
      .build();

    const declineSpy = vi.fn();
    tree.events.on('agent:elicitation_declined', declineSpy);

    await tree.tick();

    expect(declineSpy).toHaveBeenCalledWith(
      expect.objectContaining({ request: testRequest }),
    );
  });

  it('node-level options.onElicitation overrides context-level', async () => {
    const treeHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const nodeHandler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .onElicitation(treeHandler)
      .sequence('root', (b) => {
        b.agent('worker', { prompt: 'do work', options: { onElicitation: nodeHandler } });
      })
      .build();

    await tree.tick();

    expect(nodeHandler).toHaveBeenCalled();
    expect(treeHandler).not.toHaveBeenCalled();
  });

  it('deeply nested AgentNode inherits from grandparent context override', async () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .sequence('root', { context: { onElicitation: handler } }, (b) => {
        b.retry('with-retry', { maxAttempts: 2 }, (b) => {
          b.agent('deep-agent', { prompt: 'deep work' });
        });
      })
      .build();

    await tree.tick();

    expect(handler).toHaveBeenCalled();
  });

  it('events always emit to tree-level emitter regardless of context overrides', async () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .onElicitation(handler)
      .sequence('root', (b) => {
        b.agent('worker', { prompt: 'do work' });
      })
      .build();

    const enterSpy = vi.fn();
    tree.events.on('node:enter', enterSpy);

    await tree.tick();

    // All node:enter events should be on the tree-level emitter
    expect(enterSpy.mock.calls.length).toBeGreaterThan(0);
  });
});
```

### Step 2: Run integration tests

Run: `npm run test:integration`
Expected: All pass including new elicitation tests.

### Step 3: Run full test suite

Run: `npm run typecheck && npm run test:all`
Expected: All pass.

### Step 4: Commit

```bash
git add src/__integration__/elicitation.test.ts
git commit -m "test: add integration tests for elicitation context layering"
```
