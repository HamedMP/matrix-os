/**
 * Script text for the terminal page (ES5, no imports): the arrow keys that move
 * the cursor to a tapped cell on the line being typed, or "" to leave it.
 *
 * Only a tap on the cursor's own row moves it, because programs differ in how
 * a line continues on the next row. The cursor goes no further than the end of
 * the text, a cursor already past it stays, and nothing moves while the screen
 * is scrolled back or the program has hidden the cursor (it draws its own, so
 * the terminal's cursor is not where typing goes).
 */
export const TAP_CURSOR_SCRIPT = `
function terminalTapCursorMove(tap) {
  if (tap.scrolled || tap.cursorHidden || tap.row !== tap.cursorRow) return "";
  var end = Math.max(tap.lineLength, tap.cursorCol);
  var target = Math.max(0, Math.min(tap.col, end, tap.cols - 1));
  var delta = target - tap.cursorCol;
  if (!delta) return "";
  var key = delta > 0
    ? (tap.applicationCursor ? "\\x1bOC" : "\\x1b[C")
    : (tap.applicationCursor ? "\\x1bOD" : "\\x1b[D");
  var keys = "";
  for (var i = 0; i < Math.abs(delta); i++) keys += key;
  return keys;
}
`;
