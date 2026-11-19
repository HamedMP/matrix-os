/** Main auth page cleanup must commit before Clerk sign-out can clear its proof. */
export const appSessionSignOutScript = `
    function clearAppSessionBeforeSignOut(button) {
      var controller = new AbortController();
      var timeoutId;
      var pending = Promise.resolve().then(function() {
        if (!window.Clerk.session) throw new Error('Current session proof unavailable');
        return window.Clerk.session.getToken({ skipCache: true });
      }).then(function(token) {
        if (!token || controller.signal.aborted) throw new Error('Current session proof unavailable');
        return fetch('/api/auth/app-session', {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { Authorization: 'Bearer ' + token },
          signal: controller.signal
        });
      }).then(function(response) {
        if (!response.ok) throw new Error('Matrix app session clear failed');
      });
      return Promise.race([
        pending,
        new Promise(function(_, reject) {
          timeoutId = window.setTimeout(function() {
            controller.abort();
            reject(new Error('Matrix app session clear timed out'));
          }, SIGN_OUT_TIMEOUT_MS);
        })
      ]).finally(function() {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      }).catch(function(err) {
        console.warn('[matrix] App session clear failed', err instanceof Error ? err.name : String(typeof err));
        button.disabled = false;
        button.textContent = 'Sign-out is temporarily unavailable. Try again.';
        return false;
      });
    }
`;
