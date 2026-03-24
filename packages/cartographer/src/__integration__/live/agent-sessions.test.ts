import { describe, it, expect, afterEach } from 'vitest';
import { NodeStatus } from '../../types.js';
import { TreeBuilder } from '../../builder/tree-builder.js';
import { ClaudeSDKAgent } from '../../agent/claude-sdk-agent.js';
import { createTreeLogger } from '../../tree-logger.js';

const LOG_FILE = 'logs/live-agent-sessions.log';

let stopLogging: (() => void) | undefined;
afterEach(() => { stopLogging?.(); stopLogging = undefined; });

describe('Agent Named Sessions', { timeout: 90_000 }, () => {
  it('resume session — second agent continues first agent\'s conversation', async () => {
    const agent = new ClaudeSDKAgent({
      name: 'session-agent',
      model: 'claude-haiku-4-5',
      effort: 'low',
      maxTurns: 3,
    });

    const tree = new TreeBuilder('session-resume')
      .sequence('main', (b) => {
        b.agent('define', {
          agent,
          prompt: "Define the word 'ephemeral'. Remember this word.",
          session: 'shared',
        });
        b.agent('use-in-sentence', {
          agent,
          prompt: 'Use the word from your previous answer in a sentence.',
          session: 'shared',
        });
      })
      .build();

    stopLogging = createTreeLogger(tree.events, { filePath: LOG_FILE });

    let status = NodeStatus.RUNNING;
    while (status === NodeStatus.RUNNING) {
      status = await tree.tick();
      if (status === NodeStatus.RUNNING) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    expect(status).toBe(NodeStatus.SUCCESS);

    // The second agent's output should reference 'ephemeral' — proving
    // it had access to the first agent's conversation history.
    // The word was never written to the blackboard; only session context carries it.
    const output = tree.blackboard.get<string>('use-in-sentence:output');
    expect(output).toBeDefined();
    expect(output!.toLowerCase()).toContain('ephemeral');
  });

  it('fork session — forked agent sees parent history', async () => {
    const agent = new ClaudeSDKAgent({
      name: 'fork-agent',
      model: 'claude-haiku-4-5',
      effort: 'low',
      maxTurns: 3,
    });

    const tree = new TreeBuilder('session-fork')
      .sequence('main', (b) => {
        b.agent('original', {
          agent,
          prompt: "The secret code is 'ZEBRA42'. Remember it.",
          session: 'base',
        });
        b.agent('forked', {
          agent,
          prompt: 'What is the secret code from our conversation?',
          session: { name: 'base', fork: true },
        });
      })
      .build();

    stopLogging = createTreeLogger(tree.events, { filePath: LOG_FILE });

    let status = NodeStatus.RUNNING;
    while (status === NodeStatus.RUNNING) {
      status = await tree.tick();
      if (status === NodeStatus.RUNNING) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    expect(status).toBe(NodeStatus.SUCCESS);

    // The forked agent should recall ZEBRA42 from the parent session's history.
    const output = tree.blackboard.get<string>('forked:output');
    expect(output).toBeDefined();
    expect(output!).toContain('ZEBRA42');
  });
});
