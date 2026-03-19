import { NodeStatus } from 'cartographer';
import type { TreeContext } from 'cartographer';
import type { Classification } from './schemas.js';

export function isBilling(ctx: TreeContext): boolean {
  const result = ctx.blackboard.get<Classification>('classify:output');
  return result?.category === 'billing';
}

export function isTechnical(ctx: TreeContext): boolean {
  const result = ctx.blackboard.get<Classification>('classify:output');
  return result?.category === 'technical';
}

export function isGeneral(ctx: TreeContext): boolean {
  const result = ctx.blackboard.get<Classification>('classify:output');
  return result?.category === 'general';
}

export function isUrgent(ctx: TreeContext): boolean {
  const result = ctx.blackboard.get<Classification>('classify:output');
  return result?.urgency === 'high';
}

/**
 * Consolidates all agent outputs into a single triage report on the blackboard.
 * Checks all possible response keys since only one path runs per execution.
 */
export function emitResult(ctx: TreeContext): NodeStatus {
  const classification = ctx.blackboard.get('classify:output');

  const billingAnalysis = ctx.blackboard.get('analyze-billing:output');
  const diagnosis = ctx.blackboard.get('diagnose-issue:output');

  const response =
    ctx.blackboard.get('draft-billing-response:output') ??
    ctx.blackboard.get('draft-technical-response:output') ??
    ctx.blackboard.get('draft-general-response:output') ??
    null;

  const escalation = ctx.blackboard.get('escalation-summary:output') ?? null;

  ctx.blackboard.set('triage:report', {
    classification,
    analysis: billingAnalysis ?? diagnosis ?? null,
    response,
    escalation,
  });

  return NodeStatus.SUCCESS;
}
