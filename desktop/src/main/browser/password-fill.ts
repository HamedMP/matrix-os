/** Code executed in a Browser WebContentsView after main verifies its origin. */
export function buildBrowserPasswordFillScript(origin: string, username: string, password: string): string {
  return `(() => {
    if (location.origin !== ${JSON.stringify(origin)}) return false;
    const visible = (input) => input instanceof HTMLInputElement && !input.disabled && !input.readOnly &&
      input.getClientRects().length > 0 && getComputedStyle(input).visibility !== 'hidden';
    const passwordInput = [...document.querySelectorAll('input[type="password"]')].find(visible);
    if (!passwordInput) return false;
    const form = passwordInput.closest('form') || document;
    const usernameInput = [...form.querySelectorAll('input')]
      .find((input) => visible(input) && (input.autocomplete === 'username' || input.type === 'email' || /user|email|login/i.test(input.name)));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    if (usernameInput) {
      setter.call(usernameInput, ${JSON.stringify(username)});
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
      usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setter.call(passwordInput, ${JSON.stringify(password)});
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}
