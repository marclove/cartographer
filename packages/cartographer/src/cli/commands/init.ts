import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TEMPLATE = `import type { RunContext, TreeRunConfig } from 'cartographer';
import {
  BehaviorTree,
  SequenceNode,
  ActionNode,
  NodeStatus,
} from 'cartographer';

export default function (ctx: RunContext): TreeRunConfig {
  const tree = new BehaviorTree({
    name: '{{NAME}}',
    root: new SequenceNode({
      name: 'main',
      children: [
        new ActionNode({
          name: 'hello',
          action: async (context) => {
            context.blackboard.set('greeting', 'Hello from {{NAME}}!');
            return NodeStatus.SUCCESS;
          },
        }),
        new ActionNode({
          name: 'log-result',
          action: async (context) => {
            const greeting = context.blackboard.get<string>('greeting');
            console.log(greeting);
            return NodeStatus.SUCCESS;
          },
        }),
      ],
    }),
  });

  return { tree };
}
`;

export function initCommand(name: string): void {
  const fileName = name.endsWith('.ts') ? name : `${name}.ts`;
  const filePath = resolve(fileName);

  if (existsSync(filePath)) {
    process.stderr.write(`Error: ${fileName} already exists\n`);
    process.exit(1);
  }

  const content = TEMPLATE.replace(/\{\{NAME\}\}/g, name.replace(/\.ts$/, ''));
  writeFileSync(filePath, content, 'utf-8');
  process.stdout.write(`Created ${fileName}\n`);
}
