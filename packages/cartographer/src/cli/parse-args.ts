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
    port?: number;
    serve: boolean;
    noDashboard: boolean;
    dashboardPort?: number;
    noTick: boolean;
    tickInterval?: number;
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
    port: undefined as number | undefined,
    serve: false,
    noDashboard: false,
    dashboardPort: undefined as number | undefined,
    noTick: false,
    tickInterval: undefined as number | undefined,
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
    } else if (arg === '--port') {
      i++;
      const parsed = parseInt(args[i], 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        process.stderr.write(`Error: --port requires a valid port number\n\n`);
        process.stdout.write(USAGE);
        process.exit(1);
      }
      flags.port = parsed;
    } else if (arg === '--serve') {
      flags.serve = true;
    } else if (arg === '--no-dashboard') {
      flags.noDashboard = true;
    } else if (arg === '--dashboard-port') {
      i++;
      const parsed = parseInt(args[i], 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        process.stderr.write(`Error: --dashboard-port requires a valid port number\n\n`);
        process.stdout.write(USAGE);
        process.exit(1);
      }
      flags.dashboardPort = parsed;
    } else if (arg === '--no-tick') {
      flags.noTick = true;
    } else if (arg === '--tick-interval') {
      i++;
      const parsed = parseInt(args[i], 10);
      if (isNaN(parsed) || parsed < 1) {
        process.stderr.write(`Error: --tick-interval requires a positive number (ms)\n\n`);
        process.stdout.write(USAGE);
        process.exit(1);
      }
      flags.tickInterval = parsed;
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

  validateFlags(flags);

  return { command, file, positional: rest, flags };
}

function validateFlags(flags: ParsedArgs['flags']): void {
  if (flags.serve) {
    if (!flags.noTick && flags.tickInterval === undefined) {
      throw new Error('--serve requires either --tick-interval or --no-tick');
    }
  }
  if (flags.noTick && !flags.serve) {
    throw new Error('--no-tick requires --serve');
  }
  if (flags.tickInterval !== undefined && !flags.serve) {
    throw new Error('--tick-interval requires --serve');
  }
  if (flags.noTick && flags.tickInterval !== undefined) {
    throw new Error('--no-tick and --tick-interval cannot be used together');
  }
  if (flags.port !== undefined && !flags.serve) {
    throw new Error('--port requires --serve');
  }
  if (flags.noDashboard && !flags.serve) {
    throw new Error('--no-dashboard requires --serve');
  }
  if (flags.dashboardPort !== undefined && !flags.serve) {
    throw new Error('--dashboard-port requires --serve');
  }
}

export const USAGE = `Usage: cartographer <command> [options]

Commands:
  run <file> [args...]     Execute a behavior tree
  inspect <file>           Visualize tree structure
  init <name>              Scaffold a new tree file

Options:
  --json                   Output events as JSON lines (NDJSON)
  --verbose                Include agent:thinking and agent:tool_use events
  --quiet                  Suppress all output except errors
  --env-file <path>        Load environment variables from a file

Serve mode (--serve):
  --serve                  Start actor server, stay alive for messages
  --tick-interval <ms>     Delay between tick cycles (required unless --no-tick)
  --no-tick                Disable auto-ticking (message-driven only)
  --port <number>          Port for the actor server (default: 3147)
  --dashboard-port <num>   Port for the dashboard server (default: 3148)
  --no-dashboard           Disable the dashboard server
`;
