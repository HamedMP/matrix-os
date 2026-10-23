import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { SharedBrowserError } from './broker.js';

export type BrowserResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const denied = new BlockList();
const deniedV6 = new BlockList();
denied.addSubnet('192.88.99.0', 24, 'ipv4');
deniedV6.addSubnet('2001::', 23, 'ipv6');
deniedV6.addSubnet('3fff::', 20, 'ipv6');
deniedV6.addSubnet('3ffe::', 16, 'ipv6');
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) denied.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:2::', 48], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) deniedV6.addSubnet(network, prefix, 'ipv6');
function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !denied.check(address, 'ipv4') : family === 6 && /^[23]/.test(address) && !deniedV6.check(address, 'ipv6');
}
export async function validateBrowserUrl(value: string, resolver: BrowserResolver = hostname => lookup(hostname, { all: true, verbatim: true })) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new SharedBrowserError('invalid_action');
    const url = new URL(value); const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname) || /(?:^|\.)1password\.(?:com|ca|eu)$/.test(hostname)) throw new SharedBrowserError('invalid_action');
    const source = new URL(url); source.search = ''; source.hash = '';
    const fixture = url.origin === 'http://127.0.0.1:8730' && /^\/invoices(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(url.pathname);
    if (fixture) return { url: url.href, sourceUrl: source.href, fixture: true };
    if (isIP(hostname) && !publicAddress(hostname)) throw new SharedBrowserError('invalid_action');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let addresses: Array<{ address: string; family: number }>;
    try { addresses = await Promise.race([resolver(hostname), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SharedBrowserError('invalid_action')), 2000); })]); }
    finally { clearTimeout(timer); }
    if (!addresses.length || addresses.length > 32 || addresses.some(entry => !publicAddress(entry.address))) throw new SharedBrowserError('invalid_action');
    // Chrome resolves independently after Fetch interception. Every redirect is
    // revalidated, but DNS rebinding remains until Chrome supports pinned DNS.
    return { url: url.href, sourceUrl: source.href, fixture: false };
  } catch (error) {
    if (!(error instanceof SharedBrowserError)) console.warn('[shared-browser] URL rejected', error instanceof TypeError ? 'invalid_url' : 'lookup_failed');
    throw new SharedBrowserError('invalid_action');
  }
}
