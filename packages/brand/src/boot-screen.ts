import { bootMarkMask } from "./boot-mark.js";
import { bootGradientColors, palette } from "./tokens.js";

/** Shared by pre-VPS HTML and both React clients; no remote assets required. */
export const matrixBootStyles = `
.matrix-boot-screen {
  box-sizing: border-box;
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  margin: 0;
  background: ${palette.surfaceInverse};
  color: white;
}
.matrix-boot-mark {
  position: relative;
  overflow: hidden;
  width: min(257.811px, 60vw, 42vh);
  aspect-ratio: 257.811 / 322.432;
  transform: translateY(-5.68vh);
  -webkit-mask: url("${bootMarkMask}") center / 100% 100% no-repeat;
  mask: url("${bootMarkMask}") center / 100% 100% no-repeat;
}
.matrix-boot-mark::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 -177px;
  width: calc(100% + 1427px);
  background-image: linear-gradient(90deg, ${bootGradientColors.join(", ")});
  background-size: 1250px 100%;
  animation: matrix-boot-gradient 4s linear infinite;
}
.matrix-boot-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
@keyframes matrix-boot-gradient {
  from { transform: translateX(0); }
  to { transform: translateX(-1250px); }
}
@media (prefers-reduced-motion: reduce) {
  .matrix-boot-mark::before { animation: none; }
}
`;
