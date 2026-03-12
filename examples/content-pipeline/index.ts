import type { RunContext, TreeRunConfig } from '../../src/index.js';
import { buildContentPipeline } from './tree.js';
import { SAMPLE_TICKET } from './prompts.js';

export default function (ctx: RunContext): TreeRunConfig {
  const tree = buildContentPipeline();
  const ticket = ctx.args[0] ?? SAMPLE_TICKET;
  tree.blackboard.set('ticket', ticket);
  return { tree };
}
