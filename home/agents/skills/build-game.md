---
name: build-game
description: Build simple browser games with canvas, input handling, and score tracking
triggers:
  - game
  - play
  - canvas game
  - p5
category: builder
tools_needed:
  - Write
  - Read
  - Bash
channel_hints:
  - web
examples:
  - build me a snake game
  - create a simple platformer
  - make a memory card game
  - build a typing speed game
composable_with:
  - app-builder
---

# Build Game

## Canvas 2D Game Loop

```tsx
const canvasRef = useRef<HTMLCanvasElement>(null);
const frameRef = useRef<number>(0);

useEffect(() => {
  const canvas = canvasRef.current!;
  const ctx = canvas.getContext("2d")!;
  canvas.width = 800;
  canvas.height = 600;

  let lastTime = 0;
  function loop(time: number) {
    const dt = (time - lastTime) / 1000;
    lastTime = time;
    update(dt);
    draw(ctx);
    frameRef.current = requestAnimationFrame(loop);
  }
  frameRef.current = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(frameRef.current);
}, []);
```

## Game State Pattern

```tsx
interface GameState {
  status: "menu" | "playing" | "paused" | "gameover";
  score: number;
  highScore: number;
  // game-specific state
}

const [game, dispatch] = useReducer(gameReducer, initialState);
```

## Input Handling

### Keyboard
```tsx
useEffect(() => {
  const keys = new Set<string>();
  const down = (e: KeyboardEvent) => { keys.add(e.key); e.preventDefault(); };
  const up = (e: KeyboardEvent) => keys.delete(e.key);
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  keysRef.current = keys;
  return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
}, []);
```

### Touch (mobile)
```tsx
const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
<canvas
  onTouchStart={e => setTouchStart({ x: e.touches[0].clientX, y: e.touches[0].clientY })}
  onTouchEnd={e => { /* calculate swipe direction from touchStart */ }}
/>
```

### Mouse
```tsx
<canvas onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); handleClick(e.clientX - rect.left, e.clientY - rect.top); }} />
```

## Score Tracking with Bridge API

```tsx
const APP = "my-game";
useEffect(() => {
  fetch(`/api/bridge/data?app=${APP}&key=highscore`).then(r => r.json()).then(d => setHighScore(d.value ?? 0));
}, []);

function saveHighScore(score: number) {
  if (score > highScore) {
    setHighScore(score);
    fetch('/api/bridge/data', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ app: APP, key: 'highscore', value: score }) });
  }
}
```

## p5.js Quick Prototypes (HTML apps)

For rapid game prototypes, use p5.js via CDN:
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.11.0/p5.min.js"></script>
<script>
let x, y, score = 0;
function setup() { createCanvas(800, 600); x = width/2; y = height/2; }
function draw() { background(10); fill(108, 92, 231); ellipse(x, y, 30); /* game logic */ }
function keyPressed() { /* input */ }
</script>
```

## Game Styling
```css
canvas { display: block; margin: 0 auto; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; }
.score { position: absolute; top: 1rem; right: 1rem; font-size: 1.5rem; font-weight: 700; color: var(--accent); }
.game-over { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0,0,0,0.8); }
```
