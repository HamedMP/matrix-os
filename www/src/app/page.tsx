export default function Home() {
  return (
    <>
      {/* Atmospheric background */}
      <div className="bg">
        <div className="water">
          <div className="shimmer" />
        </div>
      </div>
      <div className="grain" />

      {/* Page frame */}
      <div className="frame">
        {/* Top banner */}
        <div className="banner">
          <a href="/manifesto">
            Introducing Web 4 &rarr;
          </a>
        </div>

        {/* Navigation */}
        <nav className="nav">
          <a href="/about">
            About
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </a>
        </nav>

        {/* Centered logo */}
        <div className="center">
          {/* Diamond / compass mark */}
          <svg className="logo-mark" viewBox="0 0 52 72" fill="none">
            <path
              d="M26 0 L38 26 Q39 28.5 38 31 L26 58 L14 31 Q13 28.5 14 26 Z"
              fill="currentColor"
              opacity="0.9"
            />
            <path
              d="M26 58 L30 66 Q26 72 22 66 Z"
              fill="currentColor"
              opacity="0.7"
            />
          </svg>
          <span className="logo-text">Matrix OS</span>
        </div>

        {/* Bottom bar */}
        <div className="bottom">
          <span className="bottom-left">Matrix OS, Inc.</span>
          <div className="bottom-right">
            <span>EN</span>
            <span>2026</span>
          </div>
        </div>
      </div>
    </>
  );
}
