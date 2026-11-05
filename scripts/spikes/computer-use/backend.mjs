import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DISPLAY, IMAGE_LIMIT, validateFrame } from './contracts.mjs';

/** No shell; await actual child exit before acknowledging abort or timeout.
 * @param {string} file
 * @param {string[]} args
 * @param {{signal?: AbortSignal, stdin?: string, maxBytes?: number, env?: Record<string, string | undefined>}} [options]
 */
export function runBoundedProcess(file, args, { signal, stdin = '', maxBytes = 4096, env } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let chunks = [], bytes = 0, failure, settled = false, killTimer;
    const terminate = reason => {
      failure ??= reason;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const abort = () => terminate(new Error('operation_cancelled'));
    const timeout = setTimeout(() => terminate(new Error('operation_timeout')), 2000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', value => {
      bytes += value.length;
      if (bytes > maxBytes || chunks.length >= 4096) terminate(new Error('output_limit'));
      else chunks.push(value);
    });
    // Drain bounded stderr without returning content or secrets.
    let stderrBytes = 0;
    child.stderr.on('data', value => { stderrBytes += value.length; if (stderrBytes > 4096) terminate(new Error('output_limit')); });
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      const output = Buffer.concat(chunks); chunks = [];
      if (error || failure) reject(failure ?? new Error('operation_failed'));
      else resolve(output);
    };
    child.once('error', error => { failure = new Error('operation_failed'); if (!child.pid) finish(error); });
    child.once('close', code => finish(code === 0 ? undefined : new Error('operation_failed')));
    child.stdin.on('error', () => { failure ??= new Error('operation_failed'); });
    child.stdin.end(stdin);
  });
}
const KEYS = { MINUS:'minus', EQUAL:'equal', BRACKETLEFT:'bracketleft', BRACKETRIGHT:'bracketright', BACKSLASH:'backslash', SEMICOLON:'semicolon', APOSTROPHE:'apostrophe', COMMA:'comma', PERIOD:'period', SLASH:'slash', GRAVE:'grave', CTRL:'Control_L', ALT:'Alt_L', SHIFT:'Shift_L', RETURN:'Return', ESC:'Escape', TAB:'Tab', SPACE:'space', BACKSPACE:'BackSpace', DELETE:'Delete', HOME:'Home', END:'End', LEFT:'Left', RIGHT:'Right', UP:'Up', DOWN:'Down', PAGEUP:'Prior', PAGEDOWN:'Next' };
export function createX11Backend({ platform = process.platform, uid = process.getuid?.(), run = runBoundedProcess } = {}) {
  if (platform !== 'linux' || !Number.isInteger(uid) || uid <= 0) throw new Error('qualification_unavailable');
  const env = { DISPLAY, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  const invoke = (file, args, signal, stdin, maxBytes) => run(file, args, { signal, stdin, maxBytes, env });
  return {
    async command(args, signal, stdin) {
      const argv = ['keydown', 'keyup'].includes(args[0]) ? [args[0], KEYS[args[1]] ?? args[1].toLowerCase()] : args;
      await invoke('/usr/bin/xdotool', argv, signal, stdin, 4096);
    },
    async geometry(signal) {
      const output = (await invoke('/usr/bin/xdotool', ['getdisplaygeometry'], signal, '', 64)).toString('utf8').trim();
      if (!/^\d{1,4} \d{1,4}$/.test(output)) throw new Error('invalid_geometry');
      const [width, height] = output.split(' ').map(Number);
      return { width, height };
    },
    async capture(signal) {
      const output = await invoke('/usr/bin/python3', ['-I', fileURLToPath(new URL('./capture.py', import.meta.url))], signal, '', Math.ceil(IMAGE_LIMIT / 3) * 4 + 256);
      try { return validateFrame(JSON.parse(output.toString('utf8'))); }
      catch (error) { console.warn('[computer-qualification] capture_failed', error instanceof SyntaxError ? 'invalid_json' : 'invalid_image'); throw new Error('capture_unavailable'); }
    },
  };
}
