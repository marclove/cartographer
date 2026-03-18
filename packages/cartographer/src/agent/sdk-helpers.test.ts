import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod/v4';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { queryStructured } from './sdk-helpers.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

const TestSchema = z.object({ value: z.string() });

async function* mockMessages(messages: unknown[]) {
  for (const msg of messages) {
    yield msg;
  }
}

const defaultConfig = { prompt: 'test', options: {} };

describe('queryStructured - abort signal bridging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes an AbortController to the SDK when a signal is provided', async () => {
    let capturedAbortController: AbortController | undefined;

    mockQuery.mockImplementation(({ options }: any) => {
      capturedAbortController = options.abortController;
      return mockMessages([
        { type: 'result', subtype: 'success', structured_output: { value: 'ok' } },
      ]) as any;
    });

    const ac = new AbortController();
    await queryStructured('test prompt', TestSchema, defaultConfig, undefined, ac.signal);

    expect(capturedAbortController).toBeInstanceOf(AbortController);
    expect(capturedAbortController!.signal.aborted).toBe(false);
  });

  it('does not pass an AbortController when no signal is provided', async () => {
    let capturedOptions: any;

    mockQuery.mockImplementation(({ options }: any) => {
      capturedOptions = options;
      return mockMessages([
        { type: 'result', subtype: 'success', structured_output: { value: 'ok' } },
      ]) as any;
    });

    await queryStructured('test prompt', TestSchema, defaultConfig);

    expect(capturedOptions.abortController).toBeUndefined();
  });

  it('aborting the signal triggers the controller passed to the SDK', async () => {
    let capturedAbortController: AbortController | undefined;
    let resolveMessage!: () => void;

    mockQuery.mockImplementation(({ options }: any) => {
      capturedAbortController = options.abortController;
      return (async function* () {
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: 'result', subtype: 'success', structured_output: { value: 'ok' } };
      })() as any;
    });

    const ac = new AbortController();
    const promise = queryStructured('test prompt', TestSchema, defaultConfig, undefined, ac.signal);

    // Abort the source signal — the bridged controller should reflect it
    ac.abort();
    expect(capturedAbortController!.signal.aborted).toBe(true);

    resolveMessage();
    await promise;
  });

  it('immediately aborts the controller when signal is already aborted', async () => {
    let capturedAbortController: AbortController | undefined;

    mockQuery.mockImplementation(({ options }: any) => {
      capturedAbortController = options.abortController;
      return mockMessages([
        { type: 'result', subtype: 'success', structured_output: { value: 'ok' } },
      ]) as any;
    });

    const ac = new AbortController();
    ac.abort();

    await queryStructured('test prompt', TestSchema, defaultConfig, undefined, ac.signal);

    expect(capturedAbortController!.signal.aborted).toBe(true);
  });
});
