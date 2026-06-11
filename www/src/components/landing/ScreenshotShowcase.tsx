import { ScrollScreenshot } from "./ScrollScreenshot";
import { palette as c, fonts } from "./theme";
import { SectionShell } from "./primitives";
import { Reveal } from "./Reveal";

export function ScreenshotShowcase() {
  return (
    <SectionShell id="preview" className="pt-16 md:pt-28">
      <style>{`
        .screenshot-wrapper {
          border-radius: 16px;
          overflow: hidden;
          transform: translateY(var(--ss-y, 0px)) scale(var(--ss-s, 1));
          box-shadow: 0 0 7.5rem 0 rgba(50, 53, 46, 0.12), 0 30px 60px -30px rgba(50, 53, 46, 0.3);
          transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.6s ease;
        }
        .screenshot-wrapper:hover {
          transform: translateY(calc(var(--ss-y, 0px) - 8px)) scale(1.005);
          box-shadow: 0 0 8.5rem 0 rgba(50, 53, 46, 0.16), 0 40px 80px -30px rgba(50, 53, 46, 0.35);
        }
      `}</style>
      <Reveal>
        <div className="mx-auto mb-10 max-w-[40rem] text-center">
          <h2
            className="text-[1.75rem] leading-[1.15] md:text-[2.5rem]"
            style={{ fontFamily: fonts.display, color: c.deep, fontWeight: 400 }}
          >
            A real workstation, in your browser
          </h2>
          <p className="mt-4 text-[0.9375rem] leading-[1.7]" style={{ color: c.mutedFg, fontFamily: fonts.sans }}>
            Terminals, apps, files, previews, and agent sessions stay together in one cloud
            workspace that follows you everywhere.
          </p>
        </div>
      </Reveal>
      <div className="mx-auto max-w-[1200px]">
        <ScrollScreenshot />
      </div>
    </SectionShell>
  );
}
