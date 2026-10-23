const categories = Object.freeze([
  'tool_deadline', 'tool_output_limit', 'tool_failed', 'tool_start_failed',
  'fixture_deadline', 'fixture_replaced', 'invalid_response', 'service_unavailable',
]);
const contexts = Object.freeze(['runner', 'viewer', 'status', 'control', 'fixture_status', 'fixture_action', 'chrome_close']);

export class BrowserLabFailure extends Error {
  constructor(category) {
    if (!categories.includes(category)) throw new Error('Invalid failure category');
    super(category); this.category = category;
  }
}

export function failureCategory(error) {
  if (error instanceof BrowserLabFailure && categories.includes(error.category)) return error.category;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'request_deadline';
  if (error instanceof DOMException && error.name === 'AbortError') return 'request_aborted';
  if (error instanceof SyntaxError) return 'invalid_response';
  if (error instanceof TypeError) return 'request_failed';
  return 'operation_failed';
}

export function reportBrowserFailure(context, error, log = console.warn) {
  log(`[browser-lab] ${contexts.includes(context) ? context : 'operation'}: ${failureCategory(error)}`);
}
