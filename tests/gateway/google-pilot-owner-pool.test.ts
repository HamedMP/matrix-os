import { createServer, type Socket } from 'node:net';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createAppDb } from '../../packages/gateway/src/app-db.js';

describe('pilot-only actual owner-pool acquisition timeout', () => {
  it('preserves ordinary pool defaults and applies only the explicit bounded constructor option', async () => {
    const ActualPool=pg.Pool; const configs:pg.PoolConfig[]=[];
    const construct=vi.spyOn(pg,'Pool').mockImplementation(function(config) { configs.push(config!); return new ActualPool(config); });
    const ordinary=createAppDb('postgresql://synthetic@127.0.0.1/owner_test');
    const pilot=createAppDb('postgresql://synthetic@127.0.0.1/owner_test',{connectionTimeoutMillis:2000});
    try { expect(configs).toEqual([{connectionString:'postgresql://synthetic@127.0.0.1/owner_test',max:10},{connectionString:'postgresql://synthetic@127.0.0.1/owner_test',max:10,connectionTimeoutMillis:2000}]); }
    finally { await ordinary.db.destroy(); await pilot.db.destroy(); construct.mockRestore(); }
    expect(()=>createAppDb('postgresql://synthetic@127.0.0.1/owner_test',{connectionTimeoutMillis:0 as never})).toThrow('Owner database configuration unavailable');
  });
  it('times out and drains an actual stalled PostgreSQL handshake instead of leaving a borrowed connection alive', async () => {
    const sockets=new Set<Socket>(); const server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.resume();});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)); const address=server.address(); if(!address||typeof address==='string')throw new Error('fixture unavailable');
    const app=createAppDb(`postgresql://synthetic@127.0.0.1:${address.port}/owner_test`,{connectionTimeoutMillis:2000});
    const bound=setTimeout(()=>{for(const socket of sockets)socket.destroy();},3500);
    const start=Date.now();
    try { await expect(app.db.raw('SELECT 1')).rejects.toThrow(); expect(Date.now()-start).toBeGreaterThanOrEqual(1500); expect(Date.now()-start).toBeLessThan(3000); await app.db.destroy(); await vi.waitFor(()=>expect(sockets.size).toBe(0)); }
    finally { clearTimeout(bound); await app.db.destroy(); for(const socket of sockets)socket.destroy(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
});
