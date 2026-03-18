import { z } from 'zod/v4';
import { TreeBuilder, NodeStatus } from '../../packages/cartographer/src/index.js';
import {
  ClassificationSchema,
  BillingAnalysisSchema,
  ResponseSchema,
  EscalationSchema,
} from './schemas.js';
import {
  classifyPrompt,
  analyzeBillingPrompt,
  draftBillingResponsePrompt,
  diagnoseIssuePrompt,
  draftTechnicalResponsePrompt,
  draftGeneralResponsePrompt,
  escalationPrompt,
} from './prompts.js';
import {
  isBilling,
  isTechnical,
  isGeneral,
  isUrgent,
  emitResult,
} from './actions.js';

/**
 * Builds the content pipeline behavior tree.
 *
 * Tree structure:
 *   sequence "triage"
 *   ├── agent "classify" (structured)
 *   ├── selector "route-by-category"
 *   │   ├── sequence "billing-path"
 *   │   │   ├── condition "is-billing"
 *   │   │   ├── agent "analyze-billing" (structured)
 *   │   │   └── retry(2) → agent "draft-billing-response" (unstructured)
 *   │   ├── sequence "technical-path"
 *   │   │   ├── condition "is-technical"
 *   │   │   ├── retry(2) → agent "diagnose-issue" (unstructured)
 *   │   │   └── agent "draft-technical-response" (strucutured)
 *   │   └── sequence "general-path"
 *   │       ├── condition "is-general"
 *   │       └── agent "draft-general-response" (structured)
 *   ├── alwaysSucceed → guard(isUrgent) → agent "escalation-summary" (structured)
 *   └── action "emit-result"
 */
export function buildContentPipeline() {
  return new TreeBuilder('triage-pipeline')
    .sequence('triage', (b) => {
      // Step 1: Classify the ticket
      b.agent('classify', {
        prompt: classifyPrompt,
        options: {
          model: 'claude-haiku-4-5',
          effort: 'low',
          outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ClassificationSchema) as any },
        },
      });

      // Step 2: Route based on classification
      b.selector('route-by-category', (b) => {
        b.sequence('billing-path', (b) => {
          b.condition('is-billing', isBilling);
          b.agent('analyze-billing', {
            prompt: analyzeBillingPrompt,
            options: {
              model: 'claude-haiku-4-5',
              outputFormat: { type: 'json_schema', schema: z.toJSONSchema(BillingAnalysisSchema) as any },
            },
          });
          b.retry('draft-billing-retry', { maxAttempts: 2 }, (b) => {
            b.agent('draft-billing-response', {
              prompt: draftBillingResponsePrompt,
              options: { model: 'claude-haiku-4-5', maxTurns: 3 },
            });
          });
        });

        b.sequence('technical-path', (b) => {
          b.condition('is-technical', isTechnical);
          b.retry('diagnose-retry', { maxAttempts: 2 }, (b) => {
            b.agent('diagnose-issue', {
              prompt: diagnoseIssuePrompt,
              options: { model: 'claude-haiku-4-5', maxTurns: 3 },
            });
          });
          b.agent('draft-technical-response', {
            prompt: draftTechnicalResponsePrompt,
            options: {
              model: 'claude-haiku-4-5',
              outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ResponseSchema) as any },
            },
          });
        });

        b.sequence('general-path', (b) => {
          b.condition('is-general', isGeneral);
          b.agent('draft-general-response', {
            prompt: draftGeneralResponsePrompt,
            options: {
              model: 'claude-haiku-4-5',
              outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ResponseSchema) as any },
            },
          });
        });
      });

      // Step 3: Conditional escalation for urgent tickets.
      // Guard returns FAILURE when condition is false, which would fail the
      // outer sequence. Wrapping in alwaysSucceed makes escalation optional.
      b.alwaysSucceed('optional-escalation', (b) => {
        b.guard('escalation-gate', { condition: isUrgent }, (b) => {
          b.agent('escalation-summary', {
            prompt: escalationPrompt,
            options: {
              model: 'claude-haiku-4-5',
              outputFormat: { type: 'json_schema', schema: z.toJSONSchema(EscalationSchema) as any },
            },
          });
        });
      });

      // Step 4: Consolidate results
      b.action('emit-result', emitResult);
    })
    .build();
}
