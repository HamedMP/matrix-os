import { BrandLogo } from "../../design/BrandPanel";
import duskWallpaper from "../../../../../../shell/public/wallpapers/matrix-dusk.webp";

export function WelcomeScene() {
  return (
    <aside className="signin-scene" aria-label="Welcome to your workspace">
      <img className="signin-wallpaper" src={duskWallpaper} alt="" />
      <div className="signin-scene-shade" aria-hidden />
      <div className="signin-lockup">
        <span className="signin-logo-tile"><BrandLogo size={30} color="var(--signin-green)" /></span>
        <span>Matrix OS</span>
      </div>
      <div className="signin-scene-copy">
        <span className="signin-scene-eyebrow">TECHNOLOGY THAT UNDERSTANDS YOU</span>
        <h2>A little space.<br />A lot of possibility.</h2>
        <p>Bring your ideas to life with a computer<br className="signin-wide-break" /> that works with you.</p>
      </div>
      <div className="signin-scene-footer">
        <span className="signin-scene-dot" aria-hidden />
        Your apps, files, and AI. Together in one place.
      </div>
    </aside>
  );
}
