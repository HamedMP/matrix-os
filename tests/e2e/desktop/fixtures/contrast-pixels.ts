type Pixel = number[];
export function compositePixel(under: Pixel, over: Pixel): Pixel {
  const alpha = over[3]! + under[3]! * (1 - over[3]!);
  return [...over.slice(0, 3).map((channel, index) => alpha ? (channel * over[3]! + under[index]! * under[3]! * (1 - over[3]!)) / alpha : 0), alpha];
}
/** Layer order is label to root. Opacity applies to each complete painted group. */
export function paintedContrast(color: Pixel, layers: { background: Pixel; opacity: number }[]) {
  let foreground = color;
  let background: Pixel = [0, 0, 0, 0];
  for (const layer of layers) {
    foreground = compositePixel(layer.background, foreground);
    background = compositePixel(layer.background, background);
    foreground[3] = foreground[3]! * layer.opacity;
    background[3] = background[3]! * layer.opacity;
  }
  const luminance = (pixel: Pixel) => compositePixel([1, 1, 1, 1], pixel).slice(0, 3)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0);
  const fg = luminance(foreground), bg = luminance(background);
  return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
}
