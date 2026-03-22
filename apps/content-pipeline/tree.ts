import { z } from 'zod/v4';
import { TreeBuilder, NodeStatus, ClaudeSDKAgent } from 'cartographer';
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

// --- Agent definitions ---

const classifyAgent = new ClaudeSDKAgent({
  name: 'classify',
  model: 'claude-haiku-4-5',
  effort: 'low',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ClassificationSchema) as any },
});

const analyzeBillingAgent = new ClaudeSDKAgent({
  name: 'analyze-billing',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(BillingAnalysisSchema) as any },
});

const draftBillingAgent = new ClaudeSDKAgent({
  name: 'draft-billing-response',
  model: 'claude-haiku-4-5',
  maxTurns: 3,
});

const diagnoseAgent = new ClaudeSDKAgent({
  name: 'diagnose-issue',
  model: 'claude-haiku-4-5',
  maxTurns: 3,
});

const draftTechnicalAgent = new ClaudeSDKAgent({
  name: 'draft-technical-response',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ResponseSchema) as any },
});

const draftGeneralAgent = new ClaudeSDKAgent({
  name: 'draft-general-response',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ResponseSchema) as any },
});

const escalationAgent = new ClaudeSDKAgent({
  name: 'escalation-summary',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(EscalationSchema) as any },
});

// --- Tree definition ---

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
      b.agent('classify', { agent: classifyAgent, prompt: classifyPrompt });

      // Step 2: Route based on classification
      b.selector('route-by-category', (b) => {
        b.sequence('billing-path', (b) => {
          b.condition('is-billing', isBilling);
          b.agent('analyze-billing', { agent: analyzeBillingAgent, prompt: analyzeBillingPrompt });
          b.retry('draft-billing-retry', { maxAttempts: 2 }, (b) => {
            b.agent('draft-billing-response', { agent: draftBillingAgent, prompt: draftBillingResponsePrompt });
          });
        });

        b.sequence('technical-path', (b) => {
          b.condition('is-technical', isTechnical);
          b.retry('diagnose-retry', { maxAttempts: 2 }, (b) => {
            b.agent('diagnose-issue', { agent: diagnoseAgent, prompt: diagnoseIssuePrompt });
          });
          b.agent('draft-technical-response', { agent: draftTechnicalAgent, prompt: draftTechnicalResponsePrompt });
        });

        b.sequence('general-path', (b) => {
          b.condition('is-general', isGeneral);
          b.agent('draft-general-response', { agent: draftGeneralAgent, prompt: draftGeneralResponsePrompt });
        });
      });

      // Step 3: Conditional escalation for urgent tickets.
      b.alwaysSucceed('optional-escalation', (b) => {
        b.guard('escalation-gate', { condition: isUrgent }, (b) => {
          b.agent('escalation-summary', { agent: escalationAgent, prompt: escalationPrompt });
        });
      });

      // Step 4: Consolidate results
      b.action('emit-result', emitResult);
    })
    .build();
}
