---
name: build-game
description: Build simple browser games with canvas, input handling, and score tracking Triggers: game, play, canvas game, p5. Examples: build me a snake game; create a simple platformer; make a memory card game.
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

```javascript
var BRIDGE = location.origin + '/api/bridge/data';
var APP = 'my-game';

function loadBest() {
  fetch(BRIDGE, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'read', app: APP, key: 'highscore' })
  }).then(r => r.json()).then(d => {
    if (d && d.value != null) best = typeof d.value === 'number' ? d.value : parseInt(d.value) || 0;
    updateHUD();
  }).catch(() => {});
}

function saveBest() {
  fetch(BRIDGE, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'write', app: APP, key: 'highscore', value: best })
  }).catch(() => {});
}
```

## Auto-Update (MANDATORY)
Games MUST listen for external data changes so scores/stats update when modified from chat or other agents:
```javascript
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'os:data-change') {
    loadBest(); // Re-fetch scores from bridge
  }
});
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
All colors via CSS custom properties:
```css
canvas { display: block; margin: 0 auto; background: var(--matrix-bg, #0e0e0e); border: 1px solid var(--matrix-border, #333); border-radius: 8px; }
.score { position: absolute; top: 1rem; right: 1rem; font-size: 1.5rem; font-weight: 700; color: var(--matrix-accent, #007aff); font-variant-numeric: tabular-nums; }
.game-over { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); backdrop-filter: blur(8px); border-radius: 8px; }
```

## Game Category
Set `"category": "games"` in matrix.json so the Game Center discovers the game:
```json
{ "name": "My Game", "category": "games", "runtime": "static", "tags": ["arcade"] }
```
Place game in `~/apps/games/<name>/` with `matrix.json` + `index.html`.


## Matrix OS Context

- **Category**: builder
- **Channels**: web
- **Composable with**: app-builder
- **Example prompts**: build me a snake game; create a simple platformer; make a memory card game; build a typing speed game
