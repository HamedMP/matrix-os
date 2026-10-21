import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { createIntegrationIpcTools } from '../../packages/kernel/src/tools/integration-ipc.js';
const registered = () => createIntegrationIpcTools(((name: string, description: string, shape: Record<string, z.ZodType>, handler: (input: any) => Promise<any>) => ({ name, description, shape, handler })) as any) as unknown as Array<{ name: string; shape: Record<string, z.ZodType>; handler(input: unknown): Promise<any> }>;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('kernel registered integration consent tools', () => {
  it.each(['matrix', 'pipedream'])('retains full registration and forwards explicit %s consent', async connectionMethod => {
    const tools = registered(); const connect = tools.find(tool => tool.name === 'connect_service')!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: 'https://connect.test', service: 'gmail' })); vi.stubGlobal('fetch', fetcher);
    const input = z.object(connect.shape).parse({ service: 'gmail', label: 'Work', connectionMethod });
    await connect.handler(input);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ service: 'gmail', label: 'Work', connectionMethod });
    fetcher.mockClear(); expect((await connect.handler({ service: 'github', connectionMethod })).isError).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  });
  it('registers bounded capability discovery without removing previous management tools', async () => {
    const tools = registered(); expect(tools.map(tool => tool.name)).toEqual(['list_integration_inventory', 'describe_service', 'get_gmail_connection_options', 'connect_service',
      'call_service', 'list_connected_services', 'sync_services', 'disconnect_service', 'list_custom_mcp_servers', 'describe_custom_mcp_server', 'call_custom_mcp_tool']);
    const options = { methods: ['pipedream'], defaultMethod: 'pipedream' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(options)); vi.stubGlobal('fetch', fetcher);
    const result = await tools.find(tool => tool.name === 'get_gmail_connection_options')!.handler({}); expect(JSON.parse(result.content[0].text)).toEqual(options);
  });
});
