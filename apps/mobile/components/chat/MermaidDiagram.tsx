import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import WebView from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import type { ChatMarkdownTheme } from "@/lib/chat-markdown";
import { mermaidDocument } from "./mermaid-document";

export function MermaidDiagram(props: { source: string; theme: ChatMarkdownTheme }) {
  return <DiagramContent key={props.source} {...props} />;
}

function DiagramContent({ source, theme }: { source: string; theme: ChatMarkdownTheme }) {
  const document = useMemo(() => mermaidDocument(source), [source]);
  const [showSource, setShowSource] = useState(false);
  const [height, setHeight] = useState(220);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!document || ready || failed || showSource) return;
    const timer = setTimeout(() => setFailed(true), 15_000);
    return () => clearTimeout(timer);
  }, [document, ready, failed, showSource]);
  const copy = async () => {
    try { await Clipboard.setStringAsync(source); setCopied(true); setCopyFailed(false); }
    catch (error: unknown) { console.warn("[diagram] copy failed", error instanceof Error ? error.name : "UnknownError"); setCopyFailed(true); }
  };
  return <View style={{ backgroundColor: theme.codeBackground, borderColor: theme.codeBorderColor, borderWidth: 1, borderRadius: 8, overflow: "hidden", marginVertical: 4 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 10 }}>
      <Text style={[theme.textStyle, { color: theme.mutedColor }]}>Mermaid</Text>
      <View style={{ flexDirection: "row", gap: 16 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={showSource ? "Show diagram" : "Show diagram source"} onPress={() => setShowSource((value) => !value)}><Text style={theme.textStyle}>{showSource ? "Diagram" : "Source"}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy diagram source" onPress={() => void copy()}><Text style={theme.textStyle}>{copied ? "Copied" : "Copy"}</Text></Pressable>
      </View>
    </View>
    {copyFailed ? <Text accessibilityRole="alert" style={theme.textStyle}>Could not copy diagram. Try again.</Text> : null}
    {failed || !document ? <Text style={theme.textStyle}>Diagram unavailable. View the source below.</Text> : null}
    {showSource || failed || !document ? <Text selectable style={[theme.textStyle, { fontFamily: theme.monoFontFamily, padding: 10 }]}>{source}</Text>
      : <WebView source={{ html: document }} originWhitelist={["*"]} onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
        accessibilityLabel="Mermaid diagram" javaScriptEnabled domStorageEnabled={false} allowFileAccess={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false} scrollEnabled nestedScrollEnabled style={{ height, backgroundColor: "transparent" }}
        onError={() => setFailed(true)} onMessage={(event) => {
          if (event.nativeEvent.data.length > 100) return;
          try {
            const value: unknown = JSON.parse(event.nativeEvent.data);
            if (!value || typeof value !== "object") return;
            if ("error" in value && value.error === true) setFailed(true);
            if ("height" in value && typeof value.height === "number" && Number.isFinite(value.height)) {
              setHeight(Math.max(80, Math.min(1000, value.height)));
              setReady(true);
            }
          } catch (error: unknown) { if (!(error instanceof SyntaxError)) console.warn("[diagram] invalid message", "UnknownError"); }
        }} />}
  </View>;
}
