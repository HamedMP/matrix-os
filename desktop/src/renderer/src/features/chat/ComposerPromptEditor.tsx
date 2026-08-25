import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  DecoratorNode,
  type EditorState,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { Box, SquareTerminal, X } from "lucide-react";
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
  composerReferenceTokenKey,
  serializeComposerReferenceToken,
  type ComposerReferenceToken,
} from "./composer-reference-tokens";

type SerializedComposerTokenNode = Spread<{
  token: ComposerReferenceToken;
  type: "composer-token";
  version: 1;
}, SerializedLexicalNode>;

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
      className="group relative mx-px inline-flex max-w-64 select-none items-center gap-1 align-[-0.08em] text-[0.92em] font-medium"
      style={{ color: "var(--accent)" }}
    >
      <span data-slot="composer-reference-token-icon" className="inline-flex shrink-0 items-center justify-center">
        {token.type === "invocation"
          ? token.invocation.kind === "skill" ? <Box size={14} aria-hidden /> : <SquareTerminal size={14} aria-hidden />
          : <ComposerResourceGlyph resource={token.resource} />}
      </span>
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${kind} ${label}`}
        tabIndex={-1}
        className="absolute -right-3 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--bg-surface)] opacity-0 shadow-sm transition-opacity hover:bg-[var(--bg-hover)] group-hover:opacity-100 group-focus-within:opacity-100"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          editor.update(() => $getNodeByKey(nodeKey)?.remove());
          editor.focus();
        }}
      >
        <X size={11} aria-hidden />
      </button>
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
    return serializeComposerReferenceToken(this.__token);
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return <ComposerToken token={this.__token} nodeKey={this.__key} />;
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

export interface ComposerPromptEditorHandle {
  focus: () => void;
  insertToken: (token: ComposerReferenceToken, trigger?: string) => void;
}

interface ComposerPromptEditorProps {
  value: string;
  tokens: ComposerReferenceToken[];
  onChange: (value: string, tokens: ComposerReferenceToken[], cursor: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean | void;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
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
  autoFocus,
  focusRequestId,
  editorRef,
}: ComposerPromptEditorProps & { editorRef: React.Ref<ComposerPromptEditorHandle> }) {
  const [editor] = useLexicalComposerContext();
  const applyingRef = useRef(false);

  useEffect(() => editor.setEditable(!disabled), [disabled, editor]);
  useEffect(() => {
    if (autoFocus) editor.focus();
  }, [autoFocus, editor]);
  useEffect(() => {
    if (focusRequestId && focusRequestId > 0) editor.focus();
  }, [editor, focusRequestId]);

  useLayoutEffect(() => {
    const signature = tokenSignature(tokens);
    const current = editor.getEditorState().read(() => ({
      value: $getRoot().getTextContent(),
      signature: tokenSignature(collectTokens($getRoot())),
    }));
    if (current.value === value && current.signature === signature) return;
    applyingRef.current = true;
    editor.update(() => $setPrompt(value, tokens));
    queueMicrotask(() => { applyingRef.current = false; });
  }, [editor, tokens, value]);

  useImperativeHandle(editorRef, () => ({
    focus: () => editor.focus(),
    insertToken: (token, trigger = "") => {
      editor.focus();
      editor.update(() => {
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
      });
    },
  }), [editor]);

  const handleChange = useCallback((state: EditorState) => {
    if (applyingRef.current) return;
    state.read(() => {
      const nextValue = $getRoot().getTextContent();
      const nextTokens = collectTokens($getRoot());
      onChange(nextValue, nextTokens, absoluteSelectionOffset());
    });
  }, [onChange]);

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
            className="block max-h-[220px] min-h-11 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-4 pt-3 pb-1.5 text-md leading-relaxed outline-none disabled:opacity-60"
            onKeyDown={(event) => { onKeyDown(event); }}
          />
        )}
        placeholder={(
          <div className="pointer-events-none absolute inset-x-4 top-3 text-md leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
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
