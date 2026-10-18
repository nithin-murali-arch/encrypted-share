#!/usr/bin/env node
import chalk from 'chalk';
import { SingleBar, Presets } from 'cli-progress';
import { Command } from 'commander';
import ora from 'ora';
import { resolve } from 'path';
import { sendFiles } from './client';
import { loadConfig } from './config';
import { TransferError } from './protocol';
import { startServer } from './server';

function fail(code: number, message: string): never {
  console.error(chalk.red(message));
  process.exit(code);
}

function exitCodeFor(err: unknown): number {
  if (err instanceof TransferError) {
    return ['bad-config', 'not-found', 'not-supported'].includes(err.code) ? 1 : 2;
  }
  return 2;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parsePort(raw: unknown, source: string): number {
  const port = parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(1, `Error: invalid port ${JSON.stringify(raw)} from ${source} (expected 0-65535)`);
  }
  return port;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('encrypted-share')
    .description('Securely share files via TCP with AES-256-GCM encryption')
    .version((require('../package.json') as { version: string }).version);

  program
    .command('serve')
    .description('Start the file receiving server')
    .option('-p, --port <number>', 'Port to listen on')
    .option('-H, --host <address>', 'Address to listen on (default: all interfaces)')
    .option('-k, --key <string>', 'Encryption key (password)')
    .option('-o, --out <path>', 'Output directory (default: ./received-files)')
    .option('-c, --config <path>', 'Path to config file')
    .option('--overwrite', 'Overwrite existing files')
    .action(async (options) => {
      const config = loadConfig(options.config);
      const port = parsePort(options.port ?? config.port ?? '3000', '--port or config file');
      const key = options.key ?? config.key;
      if (!key) {
        fail(1, 'Error: Key is required. Provide via --key or config file.');
      }
      const outDir = resolve(options.out ?? config.outputDir ?? './received-files');
      const starting = ora('Starting server...').start();
      try {
        const handle = await startServer({
          host: options.host ?? config.host,
          port,
          password: key,
          outDir,
          overwrite: options.overwrite === true,
          onTransfer: (msg) => console.log(chalk.dim(`[${new Date().toISOString()}] `) + msg),
        });
        const host = handle.host.includes(':') ? `[${handle.host}]` : handle.host;
        starting.succeed(`Server listening on ${host}:${handle.port}`);
        console.log(`Saving files to: ${chalk.cyan(outDir)}`);
        const shutdown = async (): Promise<void> => {
          console.log(chalk.dim('\nShutting down...'));
          await handle.close();
          process.exit(0);
        };
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
      } catch (err) {
        starting.fail('Failed to start server');
        fail(exitCodeFor(err), `Error: ${errorMessage(err)}`);
      }
    });

  program
    .command('send [path]')
    .description('Send files or directories to a server')
    .option('-t, --target <host:port>', 'Target server address')
    .option('-k, --key <string>', 'Encryption key (password)')
    .option('-c, --config <path>', 'Path to config file')
    .action(async (dirPath: string | undefined, options) => {
      const config = loadConfig(options.config);
      const target = options.target ?? config.server;
      const key = options.key ?? config.key;
      if (!target) {
        fail(1, 'Error: Target is required (e.g. localhost:3000). Provide via --target or config file.');
      }
      if (!key) {
        fail(1, 'Error: Key is required. Provide via --key or config file.');
      }
      const [host, portStr] = String(target).split(':');
      if (!host || portStr === undefined) {
        fail(1, 'Error: Invalid target format. Expected host:port');
      }
      const port = parsePort(portStr, '--target');
      const targetPath = resolve(dirPath ?? process.cwd());

      const bar = new SingleBar(
        {
          format: `${chalk.cyan('{bar}')} {percentage}% | {value}/{total} bytes`,
          hideCursor: true,
        },
        Presets.shades_classic,
      );
      let barActive = false;
      const stopBar = (): void => {
        if (barActive) {
          bar.stop();
          barActive = false;
        }
      };
      try {
        console.log(`Sending ${chalk.cyan(targetPath)} to ${chalk.cyan(target)}...`);
        const report = await sendFiles({
          host,
          port,
          password: key,
          path: targetPath,
          onProgress: (sent, total) => {
            if (total === 0) return;
            if (!barActive) {
              bar.start(total, 0);
              barActive = true;
            }
            bar.update(sent);
          },
          onWarn: (msg) => console.log(chalk.yellow(`warning: ${msg}`)),
        });
        stopBar();
        console.log(
          chalk.green(`Verified by server: ${report.files.length} file(s), ${report.bytes} bytes sent`),
        );
      } catch (err) {
        stopBar();
        fail(exitCodeFor(err), `Error: ${errorMessage(err)}`);
      }
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  await createProgram().parseAsync(argv);
}

if (require.main === module) {
  main(process.argv).catch((err: unknown) => fail(1, `Error: ${errorMessage(err)}`));
}
