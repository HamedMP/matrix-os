/**
 * Runs inside the terminal WebView page as plain script. xterm calls
 * `activate` when a link in the output (an OSC 8 hyperlink, such as the device
 * login address GitHub CLI prints) is tapped. Without a handler xterm asks with
 * `confirm()` and then calls `window.open()`, which in a React Native WebView
 * replaces the terminal page with a blank one. The page only reports the
 * address; the app checks it and decides what opens.
 */
export const TERMINAL_LINK_SCRIPT = `
function terminalLinkHandler(post) {
  return {
    activate: function (event, uri) {
      if (typeof uri !== "string" || uri.length === 0) return;
      post({ type: "link", url: uri });
    },
  };
}
`;
