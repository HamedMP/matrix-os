import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPublicBrowserEgress } from '../../packages/gateway/src/shared-browser/public-egress.js';

const publicAddress = { address: '8.8.8.8', family: 4 };
const privateAddress = { address: '192.168.1.8', family: 4 };
const stops: Array<() => Promise<void>> = [];

afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())); });

async function request(port: number, authority: string, method = 'CONNECT') {
  const socket = connect(port, '127.0.0.1');
  socket.setTimeout(3000, () => socket.destroy(new Error('Fixture connection timed out')));
  await once(socket, 'connect');
  const received = once(socket, 'data');
  socket.write(`${method} ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const [chunk] = await received;
  return { socket, response: String(chunk) };
}

describe('public Chrome context egress', () => {
  it.each([
    ['127.0.0.1:443', [publicAddress]],
    ['169.254.169.254:443', [publicAddress]],
    ['localhost:443', [publicAddress]],
    ['signin.1password.com:443', [publicAddress]],
    ['[::ffff:127.0.0.1]:443', [publicAddress]],
    ['worker.example:443', [publicAddress, privateAddress]],
    ['worker.example:443', []],
    ['worker.example:22', [publicAddress]],
  ])('denies %s before opening an upstream connection', async (authority, answers) => {
    const dial = vi.fn<() => Socket>();
    const proxy = await startPublicBrowserEgress({ resolveHost: async () => answers, dial });
    stops.push(proxy.close);
    const { socket, response } = await request(proxy.port, authority);
    socket.destroy();
    expect(response).toMatch(/^HTTP\/1.1 403 /);
    expect(response).not.toContain(authority);
    expect(dial).not.toHaveBeenCalled();
  });

  it('passes tunnel bytes only to the exact address already validated', async () => {
    const endpoint = createServer(socket => socket.pipe(socket));
    endpoint.listen(0, '127.0.0.1');
    await once(endpoint, 'listening');
    const address = endpoint.address() as AddressInfo;
    const resolveHost = vi.fn(async () => [publicAddress]);
    const dial = vi.fn(() => connect(address.port, '127.0.0.1'));
    const proxy = await startPublicBrowserEgress({ resolveHost, dial });
    stops.push(async () => {
      await proxy.close();
      await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
    });
    const { socket, response } = await request(proxy.port, 'worker.example:443');
    expect(response).toMatch(/^HTTP\/1.1 200 /);
    expect(resolveHost).toHaveBeenCalledExactlyOnceWith('worker.example');
    expect(dial).toHaveBeenCalledExactlyOnceWith({ host: publicAddress.address, port: 443, family: 4 });
    const echoed = once(socket, 'data');
    socket.write('fixture');
    expect(String((await echoed)[0])).toBe('fixture');
    socket.destroy();
  });

  it('refuses cleartext forwarding without resolving or dialing', async () => {
    const resolveHost = vi.fn(async () => [publicAddress]);
    const dial = vi.fn<() => Socket>();
    const proxy = await startPublicBrowserEgress({ resolveHost, dial });
    stops.push(proxy.close);
    const { socket, response } = await request(proxy.port, 'http://worker.example/', 'GET');
    socket.destroy();
    expect(response).toMatch(/^HTTP\/1.1 403 /);
    expect(resolveHost).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  });
});
