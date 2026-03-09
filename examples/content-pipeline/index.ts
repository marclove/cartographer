import { NodeStatus } from '../../src/index.js';
import type { TreeEvents } from '../../src/index.js';
import { buildContentPipeline } from './tree.js';
import { SAMPLE_TICKET } from './prompts.js';
import type { Classification, BillingAnalysis, Response, Escalation } from './schemas.js';

async function main() {
  const tree = buildContentPipeline();
  tree.blackboard.set('ticket', SAMPLE_TICKET);

  // Track costs per agent
  const costs: Record<string, number> = {};
  tree.events.on('agent:response', (event: TreeEvents['agent:response']) => {
    const name = event.node.name;
    if (event.cost !== undefined) {
      costs[name] = (costs[name] ?? 0) + event.cost;
    }
  });

  // Log node execution for visibility
  tree.events.on('node:enter', (event: TreeEvents['node:enter']) => {
    console.log(`  -> entering: ${event.node.name}`);
  });

  console.log('=== Support Ticket Triage Pipeline ===\n');
  console.log('INCOMING TICKET:');
  console.log(SAMPLE_TICKET);
  console.log('\nPROCESSING...\n');

  const start = performance.now();
  const { status, blackboard } = await tree.run();
  const durationMs = performance.now() - start;

  // Print classification
  const classification = blackboard['classify:output'] as Classification | undefined;
  if (classification) {
    console.log('\n--- Classification ---');
    console.log(`  Category: ${classification.category}`);
    console.log(`  Urgency:  ${classification.urgency}`);
    console.log(`  Language: ${classification.language}`);
  }

  // Print analysis (if billing path)
  const analysis = blackboard['analyze-billing:output'] as BillingAnalysis | undefined;
  if (analysis) {
    console.log('\n--- Billing Analysis ---');
    console.log(`  Issue type: ${analysis.issueType}`);
    if (analysis.amountDisputed) console.log(`  Amount:     $${analysis.amountDisputed}`);
    if (analysis.accountIdentifier) console.log(`  Account:    ${analysis.accountIdentifier}`);
    console.log(`  Summary:    ${analysis.summary}`);
  }

  // Print diagnosis (if technical path)
  const diagnosis = blackboard['diagnose-issue:output'] as string | undefined;
  if (diagnosis) {
    console.log('\n--- Technical Diagnosis ---');
    console.log(`  ${diagnosis}`);
  }

  // Print response
  const response = (
    blackboard['draft-billing-response:output'] ??
    blackboard['draft-technical-response:output'] ??
    blackboard['draft-general-response:output']
  ) as Response | string | undefined;

  if (response) {
    console.log('\n--- Drafted Response ---');
    if (typeof response === 'string') {
      console.log(response);
    } else {
      console.log(`  Subject: ${response.subject}`);
      console.log(`  Body:\n${response.body}`);
      if (response.suggestedActions.length > 0) {
        console.log('  Actions:');
        for (const action of response.suggestedActions) {
          console.log(`    - ${action}`);
        }
      }
    }
  }

  // Print escalation (if urgent)
  const escalation = blackboard['escalation-summary:output'] as Escalation | undefined;
  if (escalation) {
    console.log('\n--- Escalation ---');
    console.log(`  Priority: ${escalation.priority}`);
    console.log(`  Owner:    ${escalation.suggestedOwner}`);
    console.log(`  Deadline: ${escalation.deadline}`);
    console.log(`  Summary:  ${escalation.summary}`);
  }

  // Print cost breakdown
  console.log('\n--- Cost Breakdown ---');
  let totalCost = 0;
  for (const [name, cost] of Object.entries(costs)) {
    console.log(`  ${name.padEnd(30)} $${cost.toFixed(4)}`);
    totalCost += cost;
  }
  console.log(`  ${'Total'.padEnd(30)} $${totalCost.toFixed(4)}`);

  console.log(`\nPipeline completed: ${status} (${(durationMs / 1000).toFixed(1)}s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
