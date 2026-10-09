import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { open as openExternalUrl } from "@tauri-apps/plugin-shell";
import { extractImageFromClipboard } from "../../utils/clipboard";
import { renderMarkdownToSafeHtml } from "../../utils/markdown";
// Side-effect imports that register editor contributions (actions, widgets,
// keybindings). Without these, editor.api gives you a bare-bones editor —
// undo/redo (cursorUndo), word-level caret/selection, multi-cursor, comment
// toggle, copy-line, smart-select, etc. all live in these modules.
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";
import "monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations";
import "monaco-editor/esm/vs/editor/contrib/wordPartOperations/browser/wordPartOperations";
import "monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect";
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/esm/vs/editor/contrib/comment/browser/comment";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation";
import "monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo";
import "monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations";
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching";
import { ensureMonacoEnvironment } from "./monacoEnv";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/min/vs/editor/editor.main.css";
import { useAppContext } from "../../app/context/AppContext";
import type { WorkspaceFileTab, WorkspaceTextFileTab } from "../../app/types";

const languageIdForPath = (path: string) => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "json";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".sass") || lower.endsWith(".less")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".c")) return "c";
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx") || lower.endsWith(".hpp") || lower.endsWith(".h")) return "cpp";
  if (lower.endsWith(".xml")) return "xml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".sh") || lower.endsWith(".zsh") || lower.endsWith(".bash") || lower.endsWith(".fish")) return "shell";
  if (lower.endsWith(".toml")) return "ini";
  return "plaintext";
};

const MD_IMAGE_LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)\)/g;

// Soft wrap is the default for every file tab. Long lines wrap at word
// boundaries; Monaco falls back to breaking inside a token (e.g. a long URL)
// when a single token is wider than the viewport, so there is no horizontal
// scroll by default. Alt+Z (VS Code's binding) toggles it for the rest of the
// app session. It is intentionally not persisted, so the default stays "on".
let wordWrapEnabled = true;
const wordWrapSetting = (): "on" | "off" => (wordWrapEnabled ? "on" : "off");

const isExternalHref = (href: string) => /^(https?:|mailto:)/i.test(href);

const resolveLocalHref = (href: string, fromFilePath: string): string | null => {
  if (!href || href.startsWith("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:")) return null;
  let path = href.startsWith("file://") ? href.slice("file://".length) : href;
  path = path.split("#")[0].split("?")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw path
  }
  if (!path) return null;
  if (path.startsWith("/")) return path;
  const baseDir = fromFilePath.slice(0, fromFilePath.lastIndexOf("/"));
  const parts = `${baseDir}/${path}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join("/")}`;
};

export function FileWorkspacePane(props: { tab: WorkspaceFileTab }) {
  const app = useAppContext();
  const imageTab = () => (props.tab.kind === "image_file" ? props.tab : null);
  const [editorHost, setEditorHost] = createSignal<HTMLDivElement | undefined>(undefined);
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let model: monaco.editor.ITextModel | undefined;
  let changeDisposable: monaco.IDisposable | undefined;
  let pasteDisposable: (() => void) | undefined;
  let mouseDisposable: monaco.IDisposable | undefined;
  let boundTabId: string | undefined;
  let boundHost: HTMLDivElement | undefined;

  // Markdown preview state derived from app context + tab.
  const isMarkdown = createMemo(() => app.isMarkdownTab(props.tab));
  const markdownViewMode = createMemo(() =>
    isMarkdown() ? app.getMarkdownViewMode(props.tab.id) : "source"
  );
  const renderedMarkdownHtml = createMemo(() => {
    if (!isMarkdown()) return "";
    if (markdownViewMode() !== "preview") return "";
    if (props.tab.kind !== "text_file") return "";
    return renderMarkdownToSafeHtml(props.tab.content);
  });

  const createModelForTab = (tab: WorkspaceTextFileTab) => {
    // Use the tab id in the URI so opening the same file across multiple
    // terminals doesn't collide in Monaco's global model registry.
    const uri = monaco.Uri.parse(
      `inmemory://butter/${tab.id}/${encodeURIComponent(tab.path)}`
    );
    return monaco.editor.createModel(tab.content, languageIdForPath(tab.path), uri);
  };

  const handleMarkdownPaste = async (event: ClipboardEvent) => {
    if (props.tab.kind !== "text_file") return;
    if (!isMarkdown()) return;
    if (!editor || !model) return;
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;
    const hasImageItem = Array.from(clipboardData.items).some((item) =>
      item.type.startsWith("image/")
    );
    const image = extractImageFromClipboard(clipboardData);
    if (!hasImageItem && !image) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    try {
      const path = await invoke<string>("save_clipboard_image");
      const basename = path.split("/").pop() || path;
      const snippet = `![${basename}](${path})`;
      const selection = editor.getSelection();
      if (!selection) return;
      editor.executeEdits("butter-md-paste-image", [
        { range: selection, text: snippet, forceMoveMarkers: true },
      ]);
      editor.focus();
    } catch (err) {
      console.warn("[md-paste] save_clipboard_image failed", err);
    }
  };

  const bindPasteListener = () => {
    pasteDisposable?.();
    pasteDisposable = undefined;
    if (!editor) return;
    const domNode = editor.getDomNode();
    if (!domNode) return;
    const listener = (e: ClipboardEvent) => {
      void handleMarkdownPaste(e);
    };
    domNode.addEventListener("paste", listener, true);
    pasteDisposable = () => domNode.removeEventListener("paste", listener, true);
  };

  const bindMouseListener = () => {
    mouseDisposable?.dispose();
    mouseDisposable = undefined;
    if (!editor) return;
    mouseDisposable = editor.onMouseUp((e) => {
      if (props.tab.kind !== "text_file") return;
      if (!isMarkdown()) return;
      if (!e.event.metaKey && !e.event.ctrlKey) return;
      const pos = e.target.position;
      if (!pos || !model) return;
      const line = model.getLineContent(pos.lineNumber);
      MD_IMAGE_LINK_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MD_IMAGE_LINK_RE.exec(line)) !== null) {
        const startCol = match.index + 1;
        const endCol = match.index + match[0].length + 1;
        if (pos.column >= startCol && pos.column <= endCol) {
          e.event.preventDefault();
          e.event.stopPropagation();
          void app.openFileInButter(match[1]);
          return;
        }
      }
    });
  };

  const bindChangeListener = () => {
    changeDisposable?.dispose();
    if (!editor) {
      changeDisposable = undefined;
      return;
    }
    changeDisposable = editor.onDidChangeModelContent(() => {
      if (props.tab.kind !== "text_file") return;
      const value = model?.getValue() ?? "";
      app.updateTextFileTabContent(props.tab.ownerSessionId, props.tab.id, value);
    });
  };

  const attachTabToEditor = (tab: WorkspaceTextFileTab) => {
    if (!editor) return;
    const previousTabId = boundTabId;
    const previousModel = model;
    // Unregister the previous tab's find handler before we lose the id.
    if (previousTabId && previousTabId !== tab.id) {
      app.registerFileTabFindHandler(previousTabId, undefined);
    }
    // Temporarily unbind the change listener so attaching the new model
    // doesn't fire onDidChangeModelContent back into updateTextFileTabContent.
    changeDisposable?.dispose();
    changeDisposable = undefined;

    model = createModelForTab(tab);
    editor.setModel(model);
    previousModel?.dispose();
    boundTabId = tab.id;
    editor.updateOptions({ readOnly: tab.loading });

    bindChangeListener();

    app.registerFileTabFindHandler(tab.id, () => {
      if (!editor) {
        console.warn("[monaco-find] editor not ready for tab", tab.id);
        return;
      }
      editor.focus();
      const action = editor.getAction("actions.find");
      if (action) {
        void action.run();
      } else {
        // Fallback if the find contribution didn't register for some reason.
        console.warn("[monaco-find] actions.find not registered, using trigger fallback");
        editor.trigger("butter:find", "actions.find", null);
      }
    });
    requestAnimationFrame(() => editor?.focus());
  };

  const disposeEditor = () => {
    changeDisposable?.dispose();
    changeDisposable = undefined;
    pasteDisposable?.();
    pasteDisposable = undefined;
    mouseDisposable?.dispose();
    mouseDisposable = undefined;
    if (boundTabId) app.registerFileTabFindHandler(boundTabId, undefined);
    editor?.dispose();
    model?.dispose();
    editor = undefined;
    model = undefined;
    boundTabId = undefined;
    boundHost = undefined;
  };

  // Editor lifecycle: (re)create whenever the host div re-mounts (e.g. after
  // switching to an image tab and back flips the <Show> subtree).
  createEffect(() => {
    const host = editorHost();
    if (!host) {
      disposeEditor();
      return;
    }
    if (props.tab.kind !== "text_file") {
      disposeEditor();
      return;
    }
    if (editor && boundHost === host) return;
    if (editor) disposeEditor();

    ensureMonacoEnvironment();
    const initialTab = untrack(() => props.tab as WorkspaceTextFileTab);
    model = createModelForTab(initialTab);
    editor = monaco.editor.create(host, {
      model,
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      wordWrap: wordWrapSetting(),
      wrappingIndent: "same",
      renderWhitespace: "selection",
      readOnly: initialTab.loading,
    });
    boundTabId = initialTab.id;
    boundHost = host;

    bindChangeListener();
    bindPasteListener();
    bindMouseListener();

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA, () => {
      if (!editor || !model) return;
      editor.setSelection(model.getFullModelRange());
    });

    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => {
      wordWrapEnabled = !wordWrapEnabled;
      editor?.updateOptions({ wordWrap: wordWrapSetting() });
    });

    app.registerFileTabFindHandler(initialTab.id, () => {
      editor?.focus();
      void editor?.getAction("actions.find")?.run();
    });

    requestAnimationFrame(() => editor?.focus());
  });

  onCleanup(disposeEditor);

  // Move focus with the view: the reading view gets focus so arrow keys and
  // space scroll it; the editor gets it back when returning to source.
  let previewRef: HTMLDivElement | undefined;
  createEffect(() => {
    const mode = markdownViewMode();
    requestAnimationFrame(() => {
      if (mode === "preview") previewRef?.focus({ preventScroll: true });
      else editor?.focus();
    });
  });

  // Links in the reading view must never navigate the app webview itself.
  // Web links open in the default browser; local links open as Butter tabs.
  const handlePreviewClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") || "";
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      if (id) anchor.ownerDocument.getElementById(id)?.scrollIntoView({ block: "start" });
      return;
    }
    if (isExternalHref(href)) {
      void openExternalUrl(href).catch((err) =>
        console.warn("[md-preview] failed to open link", href, err)
      );
      return;
    }
    const localPath = resolveLocalHref(href, props.tab.path);
    if (localPath) void app.openFileInButter(localPath);
  };

  // Tab switch: rebuild model when the underlying tab id changes.
  createEffect(() => {
    if (props.tab.kind !== "text_file") return;
    if (!editor) return;
    if (props.tab.id === boundTabId) return;
    attachTabToEditor(props.tab);
  });

  // Content sync + loading flag for the currently bound tab.
  // When the user types: model.getValue() already matches props.tab.content
  // (because the change came from Monaco itself), so setValue is skipped and
  // the cursor stays put. setValue only fires on external updates (file reload).
  createEffect(() => {
    if (props.tab.kind !== "text_file") return;
    if (!editor || !model) return;
    if (props.tab.id !== boundTabId) return;
    const nextContent = props.tab.content;
    if (model.getValue() !== nextContent) {
      // External change — preserve cursor/selection across the replace.
      const selection = editor.getSelection();
      changeDisposable?.dispose();
      model.setValue(nextContent);
      bindChangeListener();
      if (selection) editor.setSelection(selection);
    }
    editor.updateOptions({ readOnly: props.tab.loading });
  });

  return (
    <section class="butter-file-workspace">
      <Show
        when={props.tab.kind === "text_file"}
        fallback={
          <div class="butter-file-preview">
            <Show when={props.tab.loading}>
              <div class="butter-file-placeholder">Loading image…</div>
            </Show>
            <Show when={!props.tab.loading && props.tab.error}>
              <div class="butter-file-error">{props.tab.error}</div>
            </Show>
            <Show when={!props.tab.loading && !props.tab.error && imageTab()?.imageUrl}>
              <img class="butter-file-preview-image" src={imageTab()?.imageUrl || ""} alt={props.tab.displayName} />
            </Show>
          </div>
        }
      >
        <div class="butter-file-editor-shell">
          <Show when={props.tab.error}>
            <div class="butter-file-banner error">{props.tab.error}</div>
          </Show>
          <Show when={props.tab.loading && !props.tab.error}>
            <div class="butter-file-banner">Loading file…</div>
          </Show>
          <div
            class="butter-file-editor"
            ref={(el) => setEditorHost(el)}
            style={{ display: markdownViewMode() === "preview" ? "none" : "" }}
          />
          <Show when={isMarkdown() && markdownViewMode() === "preview"}>
            <div
              ref={(el) => (previewRef = el)}
              class="butter-markdown-preview"
              data-butter-print-target="true"
              tabIndex={-1}
              onClick={handlePreviewClick}
            >
              <article class="butter-markdown-preview-content" innerHTML={renderedMarkdownHtml()} />
            </div>
          </Show>
        </div>
      </Show>
    </section>
  );
}
