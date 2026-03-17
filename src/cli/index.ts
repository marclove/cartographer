#!/usr/bin/env node

import { runCommand } from './commands/run.js';
import { serveCommand } from './commands/serve.js';
import { inspectCommand } from './commands/inspect.js';
import { initCommand } from './commands/init.js';
import { parseArgs, USAGE } from './parse-args.js';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed.flags.help || !parsed.command) {
    process.stdout.write(USAGE);
    process.exit(parsed.flags.help ? 0 : 1);
  }

  switch (parsed.command) {
    case 'run': {
      if (!parsed.file) {
        process.stderr.write('Error: run requires a file argument\n\n');
        process.stdout.write(USAGE);
        process.exit(1);
      }
      await runCommand({
        file: parsed.file,
        args: parsed.positional,
        json: parsed.flags.json,
        verbose: parsed.flags.verbose,
        quiet: parsed.flags.quiet,
        envFile: parsed.flags.envFile,
        port: parsed.flags.port,
        noServe: parsed.flags.noServe,
        noDashboard: parsed.flags.noDashboard,
        dashboardPort: parsed.flags.dashboardPort,
      });
      break;
    }

    case 'serve': {
      if (!parsed.file) {
        process.stderr.write('Error: serve requires a file argument\n\n');
        process.stdout.write(USAGE);
        process.exit(1);
      }
      await serveCommand({
        file: parsed.file,
        args: parsed.positional,
        quiet: parsed.flags.quiet,
        envFile: parsed.flags.envFile,
        port: parsed.flags.port,
        noDashboard: parsed.flags.noDashboard,
        dashboardPort: parsed.flags.dashboardPort,
      });
      break;
    }

    case 'inspect': {
      if (!parsed.file) {
        process.stderr.write('Error: inspect requires a file argument\n\n');
        process.stdout.write(USAGE);
        process.exit(1);
      }
      await inspectCommand(parsed.file);
      break;
    }

    case 'init': {
      if (!parsed.file) {
        process.stderr.write('Error: init requires a name argument\n\n');
        process.stdout.write(USAGE);
        process.exit(1);
      }
      initCommand(parsed.file);
      break;
    }

    default:
      process.stderr.write(`Unknown command: ${parsed.command}\n\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
