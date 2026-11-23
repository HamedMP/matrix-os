/**
 * The default indexed colour palette of a workbook: 56 colours at indexes 8
 * to 63, preceded by eight that repeat the first eight. Index 64 is the
 * system foreground and 65 the system background.
 *
 * A workbook can replace the palette in `styles.xml`; the style reader uses
 * that one when present. Number format codes (`[Color 3]`) always use this one.
 */
export const INDEXED_COLORS: readonly string[] = Object.freeze(
  (
    "000000 ffffff ff0000 00ff00 0000ff ffff00 ff00ff 00ffff " +
    "000000 ffffff ff0000 00ff00 0000ff ffff00 ff00ff 00ffff " +
    "800000 008000 000080 808000 800080 008080 c0c0c0 808080 " +
    "9999ff 993366 ffffcc ccffff 660066 ff8080 0066cc ccccff " +
    "000080 ff00ff ffff00 00ffff 800080 800000 008080 0000ff " +
    "00ccff ccffff ccffcc ffff99 99ccff ff99cc cc99ff ffcc99 " +
    "3366ff 33cccc 99cc00 ffcc00 ff9900 ff6600 666699 969696 " +
    "003366 339966 003300 333300 993300 993366 333399 333333"
  )
    .split(" ")
    .map((hex) => `#${hex}`),
);
