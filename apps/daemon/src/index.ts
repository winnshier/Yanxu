import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase, YanxuStore } from '@yanxu/core';
import { ExecutorRegistry } from './executor-registry.js';
import { Scheduler } from './scheduler.js';
import { createServer } from './server.js';
import { acquireDaemonLock } from './daemon-lock.js';

const workbenchHome = process.env.YANXU_HOME ?? join(homedir(), '.yanxu');
const daemonLock = acquireDaemonLock(workbenchHome);
const database = openDatabase(join(workbenchHome, 'system', 'app.db'));
const store = new YanxuStore(database, workbenchHome);
const executors = new ExecutorRegistry();
const scheduler = new Scheduler(store, executors);

const server = await createServer(store, executors, scheduler);
const port = Number(process.env.YANXU_PORT ?? 43120);
await server.listen({ host: '127.0.0.1', port });
scheduler.start();

if (process.env.YANXU_OPEN_BROWSER === '1') {
  const url = `http://127.0.0.1:${port}`;
  setTimeout(() => {
    const opener = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', url] : [url];
    spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
  }, 250).unref();
}

async function shutdown(signal: string): Promise<void> {
  server.log.info({ signal }, 'Yanxu is shutting down');
  scheduler.stop();
  await server.close();
  database.close();
  daemonLock.release();
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
