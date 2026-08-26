import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $applyNodeReplacement,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  DecoratorNode,
  PASTE_COMMAND,
  SKIP_SCROLL_INTO_VIEW_TAG,
  type EditorState,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { Box, SquareTerminal } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { ComposerResourceGlyph } from "./ComposerResourceGlyph";
import {
  CanonicalChatInvocationSchema,
  CanonicalChatResourceReferenceSchema,
} from "@matrix-os/contracts";
import {
  composerReferenceTokenKey,
  serializeComposerReferenceToken,
  type ComposerReferenceToken,
} from "./composer-reference-tokens";

type SerializedComposerTokenNode = Spread<{
  token: ComposerReferenceToken;
  type: "composer-token";
  version: 1;
}, SerializedLexicalNode>;

const COMPOSER_CLIPBOARD_MIME = "application/x-matrix-chat-composer+json";
const MAX_CLIPBOARD_VALUE_LENGTH = 100_000;
const MAX_CLIPBOARD_TOKENS = 100;

function visibleComposerReferenceToken(token: ComposerReferenceToken): string {
  return token.type === "invocation" ? token.invocation.invocation : token.resource.label;
}

function isComposerReferenceToken(value: unknown): value is ComposerReferenceToken {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "invocation") {
    return Boolean(
      CanonicalChatInvocationSchema.safeParse(candidate.invocation).success
      && typeof candidate.label === "string"
      && candidate.label.length <= 280,
    );
  }
  if (candidate.type !== "resource") return false;
  return CanonicalChatResourceReferenceSchema.safeParse(candidate.resource).success;
}

function parseComposerClipboardPayload(raw: string): {
  value: string;
  tokens: ComposerReferenceToken[];
} | null {
  if (!raw || raw.length > MAX_CLIPBOARD_VALUE_LENGTH * 2) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.version !== 1
      || typeof parsed.value !== "string"
      || parsed.value.length > MAX_CLIPBOARD_VALUE_LENGTH
      || !Array.isArray(parsed.tokens)
      || parsed.tokens.length > MAX_CLIPBOARD_TOKENS
      || !parsed.tokens.every(isComposerReferenceToken)
    ) return null;
    return { value: parsed.value, tokens: parsed.tokens };
  } catch {
    return null;
  }
}

function ComposerToken({ token, nodeKey }: { token: ComposerReferenceToken; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  const kind = token.type === "invocation" ? token.invocation.kind : token.resource.kind;
  const id = token.type === "invocation" ? token.invocation.descriptorId : token.resource.id;
  const label = token.type === "invocation" ? token.invocation.invocation : token.resource.label;
  return (
    <span
      contentEditable={false}
      spellCheck={false}
      aria-label={label}
      data-slot="composer-reference-token"
      data-reference-kind={kind}
      data-testid={`composer-reference-token-${kind}-${id}`}
      className="relative mx-px inline-flex max-w-64 select-text items-baseline gap-1 align-baseline text-md leading-relaxed font-medium"
      style={{ color: "var(--accent)" }}
      onDoubleClick={(event) => {
        event.preventDefault();
        editor.update(() => {
          const nodeSelection = $createNodeSelection();
          nodeSelection.add(nodeKey);
          $setSelection(nodeSelection);
        });
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(event.currentTarget);
        selection.removeAllRanges();
        selection.addRange(range);
      }}
    >
      <span data-slot="composer-reference-token-icon" className="inline-flex shrink-0 self-center items-center justify-center">
        {token.type === "invocation"
          ? token.invocation.kind === "skill" ? <Box size={14} aria-hidden /> : <SquareTerminal size={14} aria-hidden />
          : <ComposerResourceGlyph resource={token.resource} />}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

class ComposerTokenNode extends DecoratorNode<ReactElement> {
  __token: ComposerReferenceToken;

  static override getType(): string {
    return "composer-token";
  }

  static override clone(node: ComposerTokenNode): ComposerTokenNode {
    return new ComposerTokenNode(node.__token, node.__key);
  }

  static override importJSON(serialized: SerializedComposerTokenNode): ComposerTokenNode {
    return $createComposerTokenNode(serialized.token).updateFromJSON(serialized);
  }

  constructor(token: ComposerReferenceToken, key?: NodeKey) {
    super(key);
    this.__token = token;
  }

  override exportJSON(): SerializedComposerTokenNode {
    return {
      ...super.exportJSON(),
      token: this.__token,
      type: "composer-token",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "relative inline align-baseline";
    return element;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return visibleComposerReferenceToken(this.__token);
  }

  override isInline(): true {
    return true;
  }

  override isKeyboardSelectable(): false {
    return false;
  }

  override decorate(): ReactElement {
    return <ComposerToken token={this.__token} nodeKey={this.getKey()} />;
  }
}

function $createComposerTokenNode(token: ComposerReferenceToken): ComposerTokenNode {
  return $applyNodeReplacement(new ComposerTokenNode(token));
}

function collectTokens(node: LexicalNode, tokens: ComposerReferenceToken[] = []): ComposerReferenceToken[] {
  if (node instanceof ComposerTokenNode) tokens.push(node.__token);
  if ($isElementNode(node)) node.getChildren().forEach((child) => collectTokens(child, tokens));
  return tokens;
}

function tokenSignature(tokens: ComposerReferenceToken[]): string {
  return tokens.map((token) => `${composerReferenceTokenKey(token)}:${serializeComposerReferenceToken(token)}`).join("\u001f");
}

function splitValue(value: string, tokens: ComposerReferenceToken[]) {
  const remaining = [...tokens];
  const segments: Array<{ type: "text"; value: string } | { type: "token"; token: ComposerReferenceToken }> = [];
  let cursor = 0;
  while (cursor < value.length && remaining.length > 0) {
    let bestIndex = -1;
    let bestTokenIndex = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (!candidate) continue;
      const found = value.indexOf(serializeComposerReferenceToken(candidate), cursor);
      if (found >= 0 && (bestIndex < 0 || found < bestIndex)) {
        bestIndex = found;
        bestTokenIndex = index;
      }
    }
    if (bestIndex < 0 || bestTokenIndex < 0) break;
    if (bestIndex > cursor) segments.push({ type: "text", value: value.slice(cursor, bestIndex) });
    const [token] = remaining.splice(bestTokenIndex, 1);
    if (!token) break;
    segments.push({ type: "token", token });
    cursor = bestIndex + serializeComposerReferenceToken(token).length;
  }
  if (cursor < value.length) segments.push({ type: "text", value: value.slice(cursor) });
  return segments;
}

function $setPrompt(value: string, tokens: ComposerReferenceToken[]) {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  for (const segment of splitValue(value, tokens)) {
    paragraph.append(segment.type === "text" ? $createTextNode(segment.value) : $createComposerTokenNode(segment.token));
  }
  root.append(paragraph);
}

function $serializePrompt(): string {
  return $getRoot().getChildren().map((block) => {
    if (!$isElementNode(block)) return block.getTextContent();
    return block.getChildren().map((child) => (
      child instanceof ComposerTokenNode
        ? serializeComposerReferenceToken(child.__token)
        : child.getTextContent()
    )).join("");
  }).join("\n");
}

function absoluteSelectionOffset(): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return $getRoot().getTextContentSize();
  const anchor = selection.anchor;
  const node = anchor.getNode();
  let offset = 0;
  let current: LexicalNode | null = node;
  while (current) {
    const parent: LexicalNode | null = current.getParent();
    if (!parent || !$isElementNode(parent)) break;
    for (const sibling of parent.getChildren().slice(0, current.getIndexWithinParent())) {
      offset += sibling.getTextContentSize();
    }
    current = parent;
  }
  if ($isTextNode(node)) return offset + Math.min(anchor.offset, node.getTextContentSize());
  if ($isElementNode(node)) {
    for (const child of node.getChildren().slice(0, anchor.offset)) offset += child.getTextContentSize();
  }
  return offset;
}

function $selectAbsoluteOffset(offset: number): void {
  const root = $getRoot();
  const paragraph = root.getFirstChild();
  if (!$isElementNode(paragraph)) {
    root.selectEnd();
    return;
  }
  let consumed = 0;
  for (const child of paragraph.getChildren()) {
    const size = child.getTextContentSize();
    if ($isTextNode(child) && offset <= consumed + size) {
      const localOffset = Math.max(0, Math.min(offset - consumed, size));
      child.select(localOffset, localOffset);
      return;
    }
    consumed += size;
  }
  paragraph.selectEnd();
}

export interface ComposerPromptEditorHandle {
  focus: () => void;
  insertToken: (token: ComposerReferenceToken, trigger?: string, cursor?: number) => void;
}

interface ComposerPromptEditorProps {
  value: string;
  tokens: ComposerReferenceToken[];
  onChange: (value: string, tokens: ComposerReferenceToken[], cursor: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean | void;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  focusRequestId?: number;
}

function ComposerPromptEditorInner({
  value,
  tokens,
  onChange,
  onKeyDown,
  placeholder,
  ariaLabel,
  disabled,
  maxLength,
  autoFocus,
  focusRequestId,
  editorRef,
}: ComposerPromptEditorProps & { editorRef: React.Ref<ComposerPromptEditorHandle> }) {
  const [editor] = useLexicalComposerContext();
  const applyingRef = useRef(false);
  const focusEditor = useCallback(() => {
    // Focus the contenteditable synchronously so shell keyboard shortcuts can
    // type immediately, without asking Lexical to scroll a hidden draft into view.
    editor.getRootElement()?.focus({ preventScroll: true });
    editor.update(() => {
      if (!$getSelection()) $getRoot().selectEnd();
    }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
  }, [editor]);

  useEffect(() => editor.setEditable(!disabled), [disabled, editor]);
  useEffect(() => {
    if (autoFocus) focusEditor();
  }, [autoFocus, focusEditor]);
  useEffect(() => {
    if (focusRequestId && focusRequestId > 0) focusEditor();
  }, [focusEditor, focusRequestId]);

  useLayoutEffect(() => {
    const signature = tokenSignature(tokens);
    const current = editor.getEditorState().read(() => ({
      value: $serializePrompt(),
      signature: tokenSignature(collectTokens($getRoot())),
    }));
    if (current.value === value && current.signature === signature) return;
    applyingRef.current = true;
    editor.update(() => $setPrompt(value, tokens), { tag: SKIP_SCROLL_INTO_VIEW_TAG });
    queueMicrotask(() => { applyingRef.current = false; });
  }, [editor, tokens, value]);

  useImperativeHandle(editorRef, () => ({
    focus: focusEditor,
    insertToken: (token, trigger = "", cursor) => {
      focusEditor();
      editor.update(() => {
        if (typeof cursor === "number") $selectAbsoluteOffset(cursor);
        let selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          $getRoot().selectEnd();
          selection = $getSelection();
        }
        if (!$isRangeSelection(selection)) return;
        const anchorNode = selection.anchor.getNode();
        if ($isTextNode(anchorNode) && selection.isCollapsed() && trigger) {
          const end = selection.anchor.offset;
          const start = Math.max(0, end - trigger.length);
          if (anchorNode.getTextContent().slice(start, end) === trigger) {
            selection.setTextNodeRange(anchorNode, start, anchorNode, end);
          }
        }
        selection.insertNodes([$createComposerTokenNode(token), $createTextNode(" ")]);
      }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
    },
  }), [editor, focusEditor]);

  const handleChange = useCallback((state: EditorState) => {
    if (applyingRef.current) return;
    state.read(() => {
      const nextValue = $serializePrompt();
      const nextTokens = collectTokens($getRoot());
      onChange(nextValue, nextTokens, absoluteSelectionOffset());
    });
  }, [onChange]);

  useEffect(() => {
    const unregisterCopy = editor.registerCommand(COPY_COMMAND, (event) => {
      if (!event || !("clipboardData" in event) || !event.clipboardData) return false;
      const selection = $getSelection();
      if ($isNodeSelection(selection)) {
        const tokenNodes = selection.getNodes().filter(
          (node): node is ComposerTokenNode => node instanceof ComposerTokenNode,
        );
        if (tokenNodes.length === 0) return false;
        const selectedTokens = tokenNodes.map((node) => node.__token);
        const visibleText = selectedTokens.map(visibleComposerReferenceToken).join("");
        event.preventDefault();
        event.clipboardData.setData("text/plain", visibleText);
        event.clipboardData.setData(COMPOSER_CLIPBOARD_MIME, JSON.stringify({
          version: 1,
          value: selectedTokens.map(serializeComposerReferenceToken).join(""),
          tokens: selectedTokens,
        }));
        return true;
      }
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
      const text = selection.getTextContent();
      if (!text) return false;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
      if (text === $getRoot().getTextContent()) {
        event.clipboardData.setData(COMPOSER_CLIPBOARD_MIME, JSON.stringify({
          version: 1,
          value: $serializePrompt(),
          tokens: collectTokens($getRoot()),
        }));
      }
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const unregisterPaste = editor.registerCommand(PASTE_COMMAND, (event) => {
      if (!("clipboardData" in event) || !event.clipboardData) return false;
      const payload = parseComposerClipboardPayload(event.clipboardData.getData(COMPOSER_CLIPBOARD_MIME));
      if (!payload) return false;
      event.preventDefault();
      let selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        $getRoot().selectEnd();
        selection = $getSelection();
      }
      if (!$isRangeSelection(selection)) return false;
      selection.insertNodes(splitValue(payload.value, payload.tokens).map((segment) => (
        segment.type === "text" ? $createTextNode(segment.value) : $createComposerTokenNode(segment.token)
      )));
      return true;
    }, COMMAND_PRIORITY_HIGH);
    return () => {
      unregisterPaste();
      unregisterCopy();
    };
  }, [editor]);

  return (
    <div className="relative w-full">
      <PlainTextPlugin
        contentEditable={(
          <ContentEditable
            role="textbox"
            aria-label={ariaLabel}
            aria-placeholder={placeholder}
            placeholder={<span />}
            data-slot="prompt-input-content"
            data-max-length={maxLength}
            className="block max-h-[220px] min-h-9 w-full overflow-y-auto whitespace-pre-wrap break-words border-0 bg-transparent px-4 pb-1 pt-1 text-md leading-relaxed shadow-none outline-none ring-0 focus-visible:outline-none focus-visible:ring-0 [&_p]:m-0 disabled:opacity-60"
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => { onKeyDown(event); }}
          />
        )}
        placeholder={(
          <div
            data-slot="prompt-input-placeholder"
            className="pointer-events-none absolute inset-x-4 top-1 text-md leading-relaxed"
            style={{ color: "var(--text-tertiary)" }}
          >
            {placeholder}
          </div>
        )}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <OnChangePlugin onChange={handleChange} />
      <HistoryPlugin />
    </div>
  );
}

export const ComposerPromptEditor = forwardRef<ComposerPromptEditorHandle, ComposerPromptEditorProps>(
  function ComposerPromptEditor(props, ref) {
    const initialValue = useRef(props.value);
    const initialTokens = useRef(props.tokens);
    const initialConfig = useMemo<InitialConfigType>(() => ({
      namespace: "matrix-chat-composer",
      nodes: [ComposerTokenNode],
      editorState: () => $setPrompt(initialValue.current, initialTokens.current),
      onError: (error) => { throw error; },
    }), []);
    return (
      <LexicalComposer initialConfig={initialConfig}>
        <ComposerPromptEditorInner {...props} editorRef={ref} />
      </LexicalComposer>
    );
  },
);
