import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';

/** A port the system reports free, so a fork never lands on another test's or tool's port. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

/** Starts anvil forking `forkUrl` on a free port, once it answers. `stop` ends it. */
export async function startFork(forkUrl: string): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const anvil = spawn('anvil', ['--fork-url', forkUrl, '--port', String(port), '--silent'], {
    stdio: 'ignore',
  });
  for (let attempt = 0; ; attempt++) {
    const ready = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return { url, stop: () => anvil.kill() };
    if (anvil.exitCode !== null || attempt > 120) {
      anvil.kill();
      throw new Error(`anvil did not start forking ${forkUrl}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
