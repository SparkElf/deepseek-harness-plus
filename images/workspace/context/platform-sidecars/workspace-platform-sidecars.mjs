import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sidecarSpecs = [
  ['workspace-web-gateway-agent', './workspace-web-gateway-agent.mjs'],
  ['workspace-sdk-gateway', './workspace-sdk-gateway.mjs'],
];
const children = new Map();
let shuttingDown = false;

const exitWhenStopped = (exitCode) => {
  if ([...children.values()].every((child) => child.exitCode !== null || child.signalCode !== null)) {
    process.exit(exitCode);
  }
};

const shutdown = (signal, exitCode) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  const timer = setTimeout(() => process.exit(exitCode), 2_000);
  timer.unref();
  for (const child of children.values()) {
    child.once('exit', () => exitWhenStopped(exitCode));
  }
  exitWhenStopped(exitCode);
};

for (const [name, relativePath] of sidecarSpecs) {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const child = spawn(process.execPath, [path], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.set(name, child);
  child.once('error', (error) => {
    console.error(`[${name}] failed to spawn`, error);
    shutdown('SIGTERM', 1);
  });
  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited unexpectedly code=${String(code)} signal=${String(signal)}`);
    shutdown('SIGTERM', code && code !== 0 ? code : 1);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM', 0));
process.once('SIGINT', () => shutdown('SIGINT', 130));
process.once('uncaughtException', (error) => {
  console.error('[workspace-platform-sidecars] uncaught exception', error);
  shutdown('SIGTERM', 1);
});
process.once('unhandledRejection', (error) => {
  console.error('[workspace-platform-sidecars] unhandled rejection', error);
  shutdown('SIGTERM', 1);
});
