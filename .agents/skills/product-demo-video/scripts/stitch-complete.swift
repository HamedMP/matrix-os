// Stitches chapter MP4s into one video with dissolve title cards.
// Usage: swift stitch-complete.swift <recipe.json>
import AVFoundation
import AppKit
import CoreText
import Foundation

struct Chapter: Decodable {
  let src: String?
  let title: String
  let subtitle: String
  let cardSeconds: Double?
}

struct Recipe: Decodable {
  let output: String
  let width: Int
  let height: Int
  let fade: Double
  let chapters: [Chapter]
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ r: Double, _ g: Double, _ b: Double, _ a: Double) -> CGColor {
  CGColor(colorSpace: sRGB, components: [r / 255, g / 255, b / 255, a])!
}

func paragraphStyle(_ alignment: CTTextAlignment) -> CTParagraphStyle {
  var align = alignment
  var lineSpacing: CGFloat = 4
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

func attributed(_ text: String, font: CTFont, fill: CGColor) -> NSAttributedString {
  let paragraph = paragraphStyle(.center)
  return NSAttributedString(string: text, attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): fill,
    NSAttributedString.Key(kCTParagraphStyleAttributeName as String): paragraph,
  ])
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

func renderCard(title: String, subtitle: String, width: Int, height: Int) -> CGImage {
  let W = CGFloat(width), H = CGFloat(height)
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )!
  ctx.setFillColor(color(10, 14, 10, 1))
  ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
  ctx.setFillColor(color(155, 229, 139, 0.08))
  ctx.fillEllipse(in: CGRect(x: W * 0.55, y: -H * 0.15, width: W * 0.7, height: H * 0.7))
  let titleFont = NSFont.systemFont(ofSize: 46, weight: .bold) as CTFont
  let subtitleFont = NSFont.systemFont(ofSize: 22, weight: .medium) as CTFont
  let titleText = attributed(title, font: titleFont, fill: color(255, 255, 255, 1))
  let subtitleText = attributed(subtitle, font: subtitleFont, fill: color(225, 230, 220, 1))
  let titleSize = measure(titleText, maxWidth: W - 200)
  let subtitleSize = measure(subtitleText, maxWidth: W - 260)
  let gap: CGFloat = 18
  let blockH = titleSize.height + gap + subtitleSize.height
  let top = (H + blockH) / 2
  draw(titleText, in: CGRect(x: 100, y: top - titleSize.height, width: W - 200, height: titleSize.height), ctx: ctx)
  draw(subtitleText, in: CGRect(x: 130, y: top - titleSize.height - gap - subtitleSize.height, width: W - 260, height: subtitleSize.height), ctx: ctx)
  return ctx.makeImage()!
}

func writeCardClip(title: String, subtitle: String, seconds: Double, url: URL, width: Int, height: Int) throws {
  try? FileManager.default.removeItem(at: url)
  let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: 1_200_000,
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    ],
  ])
  input.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
  ])
  writer.add(input)
  guard writer.startWriting() else { throw writer.error ?? NSError(domain: "stitch", code: 1) }
  writer.startSession(atSourceTime: .zero)
  let image = renderCard(title: title, subtitle: subtitle, width: width, height: height)
  let fps = 30
  let count = max(1, Int((seconds * Double(fps)).rounded()))
  for index in 0..<count {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
    var buffer: CVPixelBuffer?
    guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let pixels = buffer
    else { throw NSError(domain: "stitch", code: 2) }
    CVPixelBufferLockBaseAddress(pixels, [])
    let ctx = CGContext(
      data: CVPixelBufferGetBaseAddress(pixels), width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: sRGB,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    )!
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(pixels, [])
    guard adaptor.append(pixels, withPresentationTime: CMTime(value: Int64(index), timescale: Int32(fps))) else {
      throw writer.error ?? NSError(domain: "stitch", code: 3)
    }
  }
  input.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  guard writer.status == .completed else { throw writer.error ?? NSError(domain: "stitch", code: 4) }
}

func fadeOverlap(fade: CMTime, incoming: CMTime, previous: CMTime?) -> CMTime {
  guard let previous, fade.seconds > 0 else { return .zero }
  let seconds = max(0, min(fade.seconds, incoming.seconds / 2, previous.seconds / 2))
  return CMTime(seconds: seconds, preferredTimescale: fade.timescale)
}

func letterbox(_ size: CGSize, into canvas: CGSize) -> CGAffineTransform {
  let scale = min(canvas.width / size.width, canvas.height / size.height)
  let tx = (canvas.width - size.width * scale) / 2
  let ty = (canvas.height - size.height * scale) / 2
  return CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: tx, ty: ty)
}

func duration(_ asset: AVAsset) async throws -> CMTime {
  if #available(macOS 13.0, *) { return try await asset.load(.duration) }
  return asset.duration
}

func naturalSize(_ asset: AVAsset) async throws -> CGSize {
  if #available(macOS 13.0, *) {
    let tracks = try await asset.loadTracks(withMediaType: .video)
    guard let track = tracks.first else { return .zero }
    let size = try await track.load(.naturalSize)
    let transform = try await track.load(.preferredTransform)
    return size.applying(transform)
  }
  guard let track = asset.tracks(withMediaType: .video).first else { return .zero }
  return track.naturalSize.applying(track.preferredTransform)
}

func stitch(_ recipePath: String) async throws {
  let recipe = try JSONDecoder().decode(Recipe.self, from: Data(contentsOf: URL(fileURLWithPath: recipePath)))
  let canvas = CGSize(width: recipe.width, height: recipe.height)
  let fade = CMTime(seconds: recipe.fade, preferredTimescale: 600)
  let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("mxo-stitch-cards-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: tmp) }

  struct Piece { let url: URL; let card: Bool }
  var pieces: [Piece] = []
  for (index, chapter) in recipe.chapters.enumerated() {
    let seconds = chapter.cardSeconds ?? 1.6
    let cardURL = tmp.appendingPathComponent(String(format: "card-%02d.mp4", index))
    try writeCardClip(title: chapter.title, subtitle: chapter.subtitle, seconds: seconds, url: cardURL, width: recipe.width, height: recipe.height)
    pieces.append(Piece(url: cardURL, card: true))
    if let src = chapter.src, !src.isEmpty {
      pieces.append(Piece(url: URL(fileURLWithPath: src), card: false))
    }
  }

  let composition = AVMutableComposition()
  guard let trackA = composition.addMutableTrack(withMediaType: .video, preferredTrackID: 1),
        let trackB = composition.addMutableTrack(withMediaType: .video, preferredTrackID: 2)
  else { throw NSError(domain: "stitch", code: 5) }

  var cursor = CMTime.zero
  var instructions: [AVMutableVideoCompositionInstruction] = []
  var previous: (track: AVMutableCompositionTrack, duration: CMTime, size: CGSize)?

  for (index, piece) in pieces.enumerated() {
    let asset = AVURLAsset(url: piece.url)
    let pieceDuration = try await duration(asset)
    let size = try await naturalSize(asset)
    let absSize = CGSize(width: abs(size.width), height: abs(size.height))
    let videoTrack = (try await asset.loadTracks(withMediaType: .video)).first
      ?? asset.tracks(withMediaType: .video).first
    guard let videoTrack else { throw NSError(domain: "stitch", code: 6) }
    let dest = index % 2 == 0 ? trackA : trackB
    let overlap = fadeOverlap(fade: fade, incoming: pieceDuration, previous: previous?.duration)
    let start = CMTimeSubtract(cursor, overlap)
    try dest.insertTimeRange(CMTimeRange(start: .zero, duration: pieceDuration), of: videoTrack, at: start)

    if let prev = previous, overlap.seconds > 0 {
      let fadeStart = start
      let fadeRange = CMTimeRange(start: fadeStart, duration: overlap)
      if let last = instructions.last {
        let remaining = CMTimeSubtract(last.timeRange.duration, overlap)
        if remaining.seconds > 0 {
          last.timeRange = CMTimeRange(start: last.timeRange.start, duration: remaining)
        } else {
          instructions.removeLast()
        }
      }
      let fadeInstruction = AVMutableVideoCompositionInstruction()
      fadeInstruction.timeRange = fadeRange
      let incoming = AVMutableVideoCompositionLayerInstruction(assetTrack: dest)
      incoming.setTransform(letterbox(absSize, into: canvas), at: fadeStart)
      incoming.setOpacityRamp(fromStartOpacity: 0, toEndOpacity: 1, timeRange: fadeRange)
      let outgoing = AVMutableVideoCompositionLayerInstruction(assetTrack: prev.track)
      outgoing.setTransform(letterbox(prev.size, into: canvas), at: fadeStart)
      outgoing.setOpacityRamp(fromStartOpacity: 1, toEndOpacity: 0, timeRange: fadeRange)
      fadeInstruction.layerInstructions = [incoming, outgoing]
      instructions.append(fadeInstruction)
    }

    let bodyStart = CMTimeAdd(start, overlap)
    let bodyDuration = CMTimeSubtract(pieceDuration, overlap)
    if bodyDuration.seconds > 0 {
      let body = AVMutableVideoCompositionInstruction()
      body.timeRange = CMTimeRange(start: bodyStart, duration: bodyDuration)
      let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: dest)
      layer.setTransform(letterbox(absSize, into: canvas), at: bodyStart)
      layer.setOpacity(1, at: bodyStart)
      body.layerInstructions = [layer]
      instructions.append(body)
    }

    cursor = CMTimeAdd(start, pieceDuration)
    previous = (dest, pieceDuration, absSize)
    print("piece \(index + 1)/\(pieces.count) \(piece.card ? "card" : "clip") \(String(format: "%.1f", pieceDuration.seconds))s")
  }

  let videoComposition = AVMutableVideoComposition()
  videoComposition.renderSize = canvas
  videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
  videoComposition.instructions = instructions

  let out = URL(fileURLWithPath: recipe.output)
  try? FileManager.default.removeItem(at: out)
  guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
    throw NSError(domain: "stitch", code: 7)
  }
  export.outputURL = out
  export.outputFileType = .mp4
  export.videoComposition = videoComposition
  export.shouldOptimizeForNetworkUse = true
  await export.export()
  if export.status != .completed {
    throw export.error ?? NSError(domain: "stitch", code: 8)
  }
  print("wrote \(recipe.output)")
}

@main
struct StitchComplete {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count > 1 else {
      print("usage: stitch-complete.swift <recipe.json>")
      exit(2)
    }
    do {
      try await stitch(args[1])
    } catch {
      print("FAILED \(error)")
      exit(1)
    }
  }
}
