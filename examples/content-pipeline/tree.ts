import { TreeBuilder, NodeStatus } from '../../src/index.js';
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
 *   ├── agent "classify" (structured, haiku)
 *   ├── selector "route-by-category"
 *   │   ├── sequence "billing-path"
 *   │   │   ├── condition "is-billing"
 *   │   │   ├── agent "analyze-billing" (structured, haiku)
 *   │   │   └── retry(2) → agent "draft-billing-response" (unstructured, sonnet)
 *   │   ├── sequence "technical-path"
 *   │   │   ├── condition "is-technical"
 *   │   │   ├── retry(2) → agent "diagnose-issue" (unstructured, sonnet)
 *   │   │   └── agent "draft-technical-response" (structured, sonnet)
 *   │   └── sequence "general-path"
 *   │       ├── condition "is-general"
 *   │       └── agent "draft-general-response" (structured, haiku)
 *   ├── alwaysSucceed → guard(isUrgent) → agent "escalation-summary" (structured, haiku)
 *   └── action "emit-result"
 */
export function buildContentPipeline() {
  return new TreeBuilder('triage-pipeline')
    .sequence('triage', (b) => {
      // Step 1: Classify the ticket
      b.agent('classify', {
        mode: 'structured',
        prompt: classifyPrompt,
        model: 'haiku',
        effort: 'low',
        outputSchema: ClassificationSchema,
      });

      // Step 2: Route based on classification
      b.selector('route-by-category', (b) => {
        b.sequence('billing-path', (b) => {
          b.condition('is-billing', isBilling);
          b.agent('analyze-billing', {
            mode: 'structured',
            prompt: analyzeBillingPrompt,
            model: 'haiku',
            outputSchema: BillingAnalysisSchema,
          });
          b.retry('draft-billing-retry', { maxAttempts: 2 }, (b) => {
            b.agent('draft-billing-response', {
              mode: 'unstructured',
              prompt: draftBillingResponsePrompt,
              model: 'sonnet',
              maxTurns: 3,
            });
          });
        });

        b.sequence('technical-path', (b) => {
          b.condition('is-technical', isTechnical);
          b.retry('diagnose-retry', { maxAttempts: 2 }, (b) => {
            b.agent('diagnose-issue', {
              mode: 'unstructured',
              prompt: diagnoseIssuePrompt,
              model: 'sonnet',
              maxTurns: 3,
            });
          });
          b.agent('draft-technical-response', {
            mode: 'structured',
            prompt: draftTechnicalResponsePrompt,
            model: 'sonnet',
            outputSchema: ResponseSchema,
          });
        });

        b.sequence('general-path', (b) => {
          b.condition('is-general', isGeneral);
          b.agent('draft-general-response', {
            mode: 'structured',
            prompt: draftGeneralResponsePrompt,
            model: 'haiku',
            outputSchema: ResponseSchema,
          });
        });
      });

      // Step 3: Conditional escalation for urgent tickets.
      // Guard returns FAILURE when condition is false, which would fail the
      // outer sequence. Wrapping in alwaysSucceed makes escalation optional.
      b.alwaysSucceed('optional-escalation', (b) => {
        b.guard('escalation-gate', { condition: isUrgent }, (b) => {
          b.agent('escalation-summary', {
            mode: 'structured',
            prompt: escalationPrompt,
            model: 'haiku',
            outputSchema: EscalationSchema,
          });
        });
      });

      // Step 4: Consolidate results
      b.action('emit-result', emitResult);
    })
    .build();
}
