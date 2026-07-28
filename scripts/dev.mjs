import { spawn } from 'node:child_process';
import process from 'node:process';

const children = [];
let stopping = false;

function start(name, args, env = {}) {
  const child = spawn('pnpm', args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

  child.once('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`[yanxu] ${name} exited (${signal ?? code})`);
      stop(code ?? 1);
    }
  });

  children.push(child);
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 300).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

start('daemon', ['--filter', '@yanxu/daemon', 'dev'], {
  YANXU_WEB_ORIGIN: 'http://127.0.0.1:43120',
  YANXU_PORT: '43121',
});
start('web', ['--filter', '@yanxu/web', 'dev']);

setTimeout(() => {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', 'http://127.0.0.1:43120'] : ['http://127.0.0.1:43120'];
  const browser = spawn(opener, args, { detached: true, stdio: 'ignore' });
  browser.unref();
}, 1400).unref();
