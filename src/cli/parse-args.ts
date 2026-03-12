export interface ParsedArgs {
  command: string;
  file: string;
  positional: string[];
  flags: {
    json: boolean;
    verbose: boolean;
    quiet: boolean;
    envFile?: string;
    help: boolean;
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  // argv[0] = node, argv[1] = script path
  const args = argv.slice(2);

  const flags = {
    json: false,
    verbose: false,
    quiet: false,
    envFile: undefined as string | undefined,
    help: false,
  };

  const positional: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--verbose') {
      flags.verbose = true;
    } else if (arg === '--quiet') {
      flags.quiet = true;
    } else if (arg === '--env-file') {
      i++;
      flags.envFile = args[i];
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--') {
      // Everything after -- is positional
      positional.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n\n`);
      process.stdout.write(USAGE);
      process.exit(1);
    } else {
      positional.push(arg);
    }
    i++;
  }

  const command = positional[0] ?? '';
  const file = positional[1] ?? '';
  const rest = positional.slice(2);

  return { command, file, positional: rest, flags };
}

export const USAGE = `Usage: cartographer <command> [options]

Commands:
  run <file> [args...]     Execute a behavior tree
  inspect <file>           Visualize tree structure
  init <name>              Scaffold a new tree file

Run options:
  --json                   Output events as JSON lines (NDJSON)
  --verbose                Include agent:thinking and agent:tool_use events
  --quiet                  Suppress all output except errors and final status
  --env-file <path>        Load environment variables from a file
`;
