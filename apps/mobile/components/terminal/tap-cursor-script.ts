/**
 * Script text for the terminal page (ES5, no imports): the arrow keys that move
 * the cursor to a tapped cell on the line being typed, or "" to leave it.
 *
 * Only a tap on the cursor's own row moves it, because programs differ in how
 * a line continues on the next row. The cursor goes no further than the end of
 * the text, a cursor already past it stays, and nothing moves while the screen
 * is scrolled back or while the program has hidden the cursor (it draws its
 * own, so the terminal's cursor is not where typing goes). The emulator's mouse
 * mode says nothing about the program: zellij always asks for the mouse.
 *
 * `widths` holds each cell's width on the row: a wide character fills two
 * cells but takes one arrow press, so its second cell (width 0) is not counted.
 * `terminalRowCells` reads them, and where the text ends, from an xterm line.
 */
export const TAP_CURSOR_SCRIPT = `
function terminalRowCells(line, cols) {
  var widths = [];
  var length = 0;
  for (var col = 0; col < cols; col++) {
    var cell = line ? line.getCell(col) : null;
    var cellWidth = cell ? cell.getWidth() : 1;
    widths.push(cellWidth);
    if (cell && cell.getChars()) length = col + Math.max(1, cellWidth);
  }
  return { widths: widths, length: length };
}
function terminalTapCursorMove(tap) {
  if (tap.scrolled || tap.cursorHidden || tap.row !== tap.cursorRow) return "";
  var widths = tap.widths || [];
  function width(col) { return typeof widths[col] === "number" ? widths[col] : 1; }
  var end = Math.max(tap.lineLength, tap.cursorCol);
  var target = Math.max(0, Math.min(tap.col, end, tap.cols - 1));
  while (target > 0 && width(target) === 0) target--;
  var low = Math.min(target, tap.cursorCol);
  var high = Math.max(target, tap.cursorCol);
  var presses = 0;
  for (var col = low; col < high; col++) if (width(col) !== 0) presses++;
  if (!presses) return "";
  var key = target > tap.cursorCol
    ? (tap.applicationCursor ? "\\x1bOC" : "\\x1b[C")
    : (tap.applicationCursor ? "\\x1bOD" : "\\x1b[D");
  var keys = "";
  for (var i = 0; i < presses; i++) keys += key;
  return keys;
}
`;
