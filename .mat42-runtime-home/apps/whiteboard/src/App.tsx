import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

const APP_ID = "whiteboard";
const STORAGE_KEY = "default-scene";
const FETCH_TIMEOUT_MS = 10_000;
const SAVE_DELAY_MS = 600;

type ExcalidrawProps = React.ComponentProps<typeof Excalidraw>;
type OnChangeArgs = Parameters<NonNullable<ExcalidrawProps["onChange"]>>;
type Elements = OnChangeArgs[0];
type AppState = OnChangeArgs[1];
type BinaryFiles = OnChangeArgs[2];

interface SavedScene {
  elements: Elements;
  appState?: Record<string, unknown>;
  files?: BinaryFiles;
  savedAt: string;
}

function pickPersistedAppState(appState: AppState): Record<string, unknown> {
  const source = appState as unknown as Record<string, unknown>;
  const keys = [
    "viewBackgroundColor",
    "theme",
    "currentItemStrokeColor",
    "currentItemBackgroundColor",
    "currentItemFillStyle",
    "currentItemStrokeWidth",
    "currentItemStrokeStyle",
    "currentItemRoughness",
    "currentItemOpacity",
    "currentItemFontFamily",
    "currentItemFontSize",
    "currentItemTextAlign",
    "gridSize",
  ];

  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

async function readScene(): Promise<SavedScene | null> {
  const params = new URLSearchParams({ app: APP_ID, key: STORAGE_KEY });
  const res = await fetch(`/api/bridge/data?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const payload = (await res.json()) as { value?: string | null };
  if (!payload.value) return null;

  try {
    return JSON.parse(payload.value) as SavedScene;
  } catch (err: unknown) {
    console.warn("[whiteboard] ignored invalid saved scene:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function writeScene(scene: SavedScene): Promise<void> {
  await fetch("/api/bridge/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      action: "write",
      app: APP_ID,
      key: STORAGE_KEY,
      value: JSON.stringify(scene),
    }),
  });
}

export default function App() {
  const [scene, setScene] = useState<SavedScene | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSceneRef = useRef<SavedScene | null>(null);

  useEffect(() => {
    let cancelled = false;
    readScene()
      .then((saved) => {
        if (cancelled) return;
        setScene(saved);
      })
      .catch((err: unknown) => {
        console.warn("[whiteboard] failed to load scene:", err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const scheduleSave = useCallback((nextScene: SavedScene) => {
    pendingSceneRef.current = nextScene;
    setSaveState("saving");

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const pending = pendingSceneRef.current;
      if (!pending) return;

      writeScene(pending)
        .then(() => setSaveState("saved"))
        .catch((err: unknown) => {
          console.warn("[whiteboard] failed to save scene:", err instanceof Error ? err.message : String(err));
          setSaveState("error");
        });
    }, SAVE_DELAY_MS);
  }, []);

  const initialData = useMemo<ExcalidrawProps["initialData"]>(() => {
    if (!scene) {
      return {
        appState: {
          viewBackgroundColor: "#f8fafc",
        },
        scrollToContent: true,
      };
    }

    return {
      elements: scene.elements,
      appState: {
        viewBackgroundColor: "#f8fafc",
        ...scene.appState,
      },
      files: scene.files,
      scrollToContent: true,
    };
  }, [scene]);

  const onChange = useCallback<NonNullable<ExcalidrawProps["onChange"]>>(
    (elements, appState, files) => {
      scheduleSave({
        elements,
        appState: pickPersistedAppState(appState),
        files,
        savedAt: new Date().toISOString(),
      });
    },
    [scheduleSave],
  );

  if (!loaded) {
    return (
      <div className="app-loading" role="status">
        Opening canvas
      </div>
    );
  }

  return (
    <div className="whiteboard-shell">
      <Excalidraw
        initialData={initialData}
        onChange={onChange}
        name="Matrix Whiteboard"
      >
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      <div className={`save-pill save-pill--${saveState}`} aria-live="polite">
        {saveState === "saving" ? "Saving" : saveState === "error" ? "Save failed" : "Saved"}
      </div>
    </div>
  );
}
