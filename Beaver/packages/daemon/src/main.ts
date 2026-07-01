import { BeaverDaemonServer } from './server';

/**
 * Daemon entrypoint. Runs on Bun in production; `serve` is the only command —
 * lifecycle (start/stop/status) is driven by clients over the socket.
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  if (command !== 'serve') {
    process.stderr.write(`Unknown daemon command: ${command}\n`);
    process.exit(1);
  }
  const server = new BeaverDaemonServer();
  const { socketPath } = await server.start();
  process.stdout.write(`beaver-daemon listening at ${socketPath}\n`);

  const shutdown = (): void => {
    void server.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
