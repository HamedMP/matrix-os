// Renders the recorded screencast frames into an H.264 MP4: camera crop, captions, title cards.
// Usage:
//   swift encode-demo.swift encode <manifest.json>
//   swift encode-demo.swift frames <video.mp4> <out-dir> <seconds...>
import AVFoundation
import AppKit
import CoreText
import Foundation

struct Caption: Decodable { let step: String?; let text: String; let alpha: Double; let x: Double; let top: Double?; let align: String; let maxWidth: Double? }
struct Card: Decodable { let title: String; let subtitle: String; let alpha: Double }
struct Frame: Decodable { let src: String; let crop: [Double]; let caption: Caption?; let card: Card? }
struct Manifest: Decodable {
  let output: String
  let width: Int
  let height: Int
  let fps: Int
  let bitrate: Int
  let cssWidth: Double
  // When set, the screen fills the top `screenHeight` px and captions sit in a strip below it.
  let screenHeight: Int?
  let frames: [Frame]
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ r: Double, _ g: Double, _ b: Double, _ a: Double) -> CGColor {
  CGColor(colorSpace: sRGB, components: [r / 255, g / 255, b / 255, a])!
}

func paragraphStyle(_ alignment: CTTextAlignment) -> CTParagraphStyle {
  var align = alignment
  var lineSpacing: CGFloat = 3
  return withUnsafePointer(to: &align) { alignPointer in
    withUnsafePointer(to: &lineSpacing) { spacingPointer in
      let settings = [
        CTParagraphStyleSetting(spec: .alignment, valueSize: MemoryLayout<CTTextAlignment>.size, value: alignPointer),
        CTParagraphStyleSetting(spec: .lineSpacingAdjustment, valueSize: MemoryLayout<CGFloat>.size, value: spacingPointer),
      ]
      return CTParagraphStyleCreate(settings, settings.count)
    }
  }
}

func attributed(_ parts: [(String, CTFont, CGColor)], alignment: CTTextAlignment) -> NSAttributedString {
  let paragraph = paragraphStyle(alignment)
  let result = NSMutableAttributedString()
  for (text, font, fill) in parts {
    result.append(NSAttributedString(string: text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): fill,
      NSAttributedString.Key(kCTParagraphStyleAttributeName as String): paragraph,
    ]))
  }
  return result
}

func measure(_ text: NSAttributedString, maxWidth: CGFloat) -> CGSize {
  let setter = CTFramesetterCreateWithAttributedString(text)
  let size = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(location: 0, length: 0), nil, CGSize(width: maxWidth, height: 10_000), nil)
  return CGSize(width: ceil(size.width), height: ceil(size.height))
}

func draw(_ text: NSAttributedString, in rect: CGRect, ctx: CGContext) {
  let setter = CTFramesetterCreateWithAttributedString(text)
  let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), CGPath(rect: rect, transform: nil), nil)
  CTFrameDraw(frame, ctx)
}

func font(_ size: CGFloat, _ weight: NSFont.Weight) -> CTFont {
  NSFont.systemFont(ofSize: size, weight: weight) as CTFont
}

func loadImage(_ path: String) -> CGImage {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
  else { fatalError("cannot decode \(path)") }
  return image
}

func render(_ frame: Frame, image: CGImage, manifest: Manifest, ctx: CGContext) {
  let W = CGFloat(manifest.width), H = CGFloat(manifest.height)
  ctx.setFillColor(color(0, 0, 0, 1))
  ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

  // Sub-pixel camera: scale the whole frame so the crop fills the output, instead of integer cropping.
  let dsf = CGFloat(image.width) / CGFloat(manifest.cssWidth)
  let cropX = CGFloat(frame.crop[0]) * dsf, cropY = CGFloat(frame.crop[1]) * dsf, cropW = CGFloat(frame.crop[2]) * dsf
  let s = W / cropW
  let imageRect = CGRect(x: -cropX * s, y: H + cropY * s - CGFloat(image.height) * s, width: CGFloat(image.width) * s, height: CGFloat(image.height) * s)
  ctx.interpolationQuality = .high
  let bandH = manifest.screenHeight.map { H - CGFloat($0) } ?? 0
  ctx.saveGState()
  ctx.clip(to: CGRect(x: 0, y: bandH, width: W, height: H - bandH))
  ctx.draw(image, in: imageRect)
  ctx.restoreGState()

  if bandH > 0 {
    ctx.setFillColor(color(10, 14, 10, 1))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: bandH))
    if let caption = frame.caption, caption.alpha > 0 {
      let a = caption.alpha
      var parts: [(String, CTFont, CGColor)] = []
      if let step = caption.step { parts.append(("\(step)    ", font(22, .bold), color(155, 229, 139, a))) }
      parts.append((caption.text, font(23, .semibold), color(246, 244, 234, a)))
      let text = attributed(parts, alignment: .center)
      let size = measure(text, maxWidth: W - 160)
      draw(text, in: CGRect(x: (W - size.width) / 2, y: (bandH - size.height) / 2, width: size.width + 1, height: size.height), ctx: ctx)
    }
  }

  if bandH == 0, let caption = frame.caption, caption.alpha > 0 {
    let a = caption.alpha
    var parts: [(String, CTFont, CGColor)] = []
    if let step = caption.step { parts.append(("\(step)   ", font(20, .bold), color(155, 229, 139, a))) }
    parts.append((caption.text, font(20, .semibold), color(246, 244, 234, a)))
    let text = attributed(parts, alignment: .left)
    let padX: CGFloat = 20, padY: CGFloat = 14
    let size = measure(text, maxWidth: CGFloat(caption.maxWidth ?? 600))
    let pillW = size.width + padX * 2, pillH = size.height + padY * 2
    let pillX = caption.align == "right" ? CGFloat(caption.x) - pillW
      : caption.align == "center" ? CGFloat(caption.x) - pillW / 2
      : CGFloat(caption.x)
    let pillY = H - CGFloat(caption.top ?? 40) - pillH
    let pill = CGRect(x: pillX, y: pillY, width: pillW, height: pillH)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 22, color: color(0, 0, 0, 0.35 * a))
    ctx.addPath(CGPath(roundedRect: pill, cornerWidth: 14, cornerHeight: 14, transform: nil))
    ctx.setFillColor(color(17, 24, 16, 0.9 * a))
    ctx.fillPath()
    ctx.restoreGState()
    draw(text, in: CGRect(x: pillX + padX, y: pillY + padY, width: size.width + 1, height: size.height), ctx: ctx)
  }

  if let card = frame.card, card.alpha > 0 {
    let a = card.alpha
    ctx.setFillColor(color(10, 14, 10, 0.72 * a))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    let title = attributed([(card.title, font(46, .bold), color(255, 255, 255, a))], alignment: .center)
    let subtitle = attributed([(card.subtitle, font(22, .medium), color(225, 230, 220, a))], alignment: .center)
    let titleSize = measure(title, maxWidth: W - 200)
    let subtitleSize = measure(subtitle, maxWidth: W - 260)
    let gap: CGFloat = 18
    let blockH = titleSize.height + gap + subtitleSize.height
    let top = (H + blockH) / 2
    draw(title, in: CGRect(x: 100, y: top - titleSize.height, width: W - 200, height: titleSize.height), ctx: ctx)
    draw(subtitle, in: CGRect(x: 130, y: top - titleSize.height - gap - subtitleSize.height, width: W - 260, height: subtitleSize.height), ctx: ctx)
  }
}

func encode(_ manifestPath: String) throws {
  let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: URL(fileURLWithPath: manifestPath)))
  let url = URL(fileURLWithPath: manifest.output)
  try? FileManager.default.removeItem(at: url)
  let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: manifest.width,
    AVVideoHeightKey: manifest.height,
    AVVideoColorPropertiesKey: [
      AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
      AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
      AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ],
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: manifest.bitrate,
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      AVVideoMaxKeyFrameIntervalKey: manifest.fps * 2,
      AVVideoExpectedSourceFrameRateKey: manifest.fps,
      AVVideoAllowFrameReorderingKey: true,
    ],
  ])
  input.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: manifest.width,
    kCVPixelBufferHeightKey as String: manifest.height,
  ])
  writer.add(input)
  guard writer.startWriting() else { throw writer.error ?? NSError(domain: "encode", code: 1) }
  writer.startSession(atSourceTime: .zero)

  var cachedPath = ""
  var cachedImage: CGImage?
  for (index, frame) in manifest.frames.enumerated() {
    if frame.src != cachedPath {
      cachedImage = loadImage(frame.src)
      cachedPath = frame.src
      if index == 0 { print("source frame size \(cachedImage!.width)x\(cachedImage!.height)") }
    }
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
    var buffer: CVPixelBuffer?
    guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let pixels = buffer
    else { throw writer.error ?? NSError(domain: "encode", code: 2) }
    CVPixelBufferLockBaseAddress(pixels, [])
    let ctx = CGContext(
      data: CVPixelBufferGetBaseAddress(pixels), width: manifest.width, height: manifest.height, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: sRGB,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    )!
    render(frame, image: cachedImage!, manifest: manifest, ctx: ctx)
    CVPixelBufferUnlockBaseAddress(pixels, [])
    guard adaptor.append(pixels, withPresentationTime: CMTime(value: Int64(index), timescale: Int32(manifest.fps))) else {
      throw writer.error ?? NSError(domain: "encode", code: 3)
    }
    if index % 300 == 0 { print("frame \(index)/\(manifest.frames.count)") }
  }
  input.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  guard writer.status == .completed else { throw writer.error ?? NSError(domain: "encode", code: 4) }
  print("wrote \(manifest.output)")
}

func extractFrames(_ videoPath: String, _ outDir: String, _ times: [Double]) throws {
  let generator = AVAssetImageGenerator(asset: AVURLAsset(url: URL(fileURLWithPath: videoPath)))
  generator.requestedTimeToleranceBefore = .zero
  generator.requestedTimeToleranceAfter = .zero
  try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
  for time in times {
    let image = try generator.copyCGImage(at: CMTime(seconds: time, preferredTimescale: 600), actualTime: nil)
    let out = URL(fileURLWithPath: outDir).appendingPathComponent(String(format: "t%06.2f.png", time))
    let dest = CGImageDestinationCreateWithURL(out as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
    print("\(out.path) \(image.width)x\(image.height)")
  }
}

// Grid of timestamped thumbnails for QA: sheet <video> <out-prefix> <start> <end> <step> [cols] [perSheet]
func contactSheets(_ videoPath: String, _ prefix: String, start: Double, end: Double, step: Double, cols: Int, perSheet: Int) throws {
  let asset = AVURLAsset(url: URL(fileURLWithPath: videoPath))
  let generator = AVAssetImageGenerator(asset: asset)
  generator.requestedTimeToleranceBefore = .zero
  generator.requestedTimeToleranceAfter = .zero
  generator.maximumSize = CGSize(width: 480, height: 480)
  var times: [Double] = []
  var t = start
  while t <= end { times.append(t); t += step }
  let thumbW: CGFloat = 360
  var sheet = 0
  for chunkStart in stride(from: 0, to: times.count, by: perSheet) {
    let chunk = Array(times[chunkStart..<min(times.count, chunkStart + perSheet)])
    var images: [(Double, CGImage)] = []
    for time in chunk {
      if let image = try? generator.copyCGImage(at: CMTime(seconds: time, preferredTimescale: 600), actualTime: nil) {
        images.append((time, image))
      }
    }
    guard let first = images.first?.1 else { continue }
    let thumbH = thumbW * CGFloat(first.height) / CGFloat(first.width)
    let labelH: CGFloat = 22
    let rows = Int(ceil(Double(images.count) / Double(cols)))
    let W = Int(thumbW) * cols, H = Int((thumbH + labelH) * CGFloat(rows))
    let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.setFillColor(color(30, 30, 30, 1))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    for (i, (time, image)) in images.enumerated() {
      let col = i % cols, row = i / cols
      let x = CGFloat(col) * thumbW
      let y = CGFloat(H) - CGFloat(row + 1) * (thumbH + labelH)
      ctx.draw(image, in: CGRect(x: x + 2, y: y + 2, width: thumbW - 4, height: thumbH - 4))
      let label = attributed([(String(format: "%.1fs", time), font(15, .bold), color(255, 230, 120, 1))], alignment: .left)
      draw(label, in: CGRect(x: x + 6, y: y + thumbH, width: thumbW - 12, height: labelH - 2), ctx: ctx)
    }
    let out = URL(fileURLWithPath: "\(prefix)-\(sheet).png")
    let dest = CGImageDestinationCreateWithURL(out as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
    print(out.path)
    sheet += 1
  }
}

let args = CommandLine.arguments
do {
  switch args.count > 1 ? args[1] : "" {
  case "encode": try encode(args[2])
  case "frames": try extractFrames(args[2], args[3], args.dropFirst(4).compactMap(Double.init))
  case "sheet":
    try contactSheets(args[2], args[3], start: Double(args[4])!, end: Double(args[5])!, step: Double(args[6])!,
                      cols: args.count > 7 ? Int(args[7])! : 4, perSheet: args.count > 8 ? Int(args[8])! : 20)
  default: print("usage: encode <manifest> | frames <video> <out> <seconds...> | sheet <video> <prefix> <start> <end> <step> [cols] [perSheet]"); exit(2)
  }
} catch {
  print("FAILED \(error)")
  exit(1)
}
