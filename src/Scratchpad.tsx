import { createSignal, createEffect, onMount, For } from "solid-js";
import type { JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Check if clipboard data contains an image
function hasImageInClipboard(clipboardData: DataTransfer | null): boolean {
  if (!clipboardData) return false;
  for (const file of Array.from(clipboardData.files)) {
    if (file.type.startsWith("image/")) return true;
  }
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) return true;
  }
  return false;
}

// Syntax highlight a single line - returns JSX with styled spans
function highlightLine(line: string): JSX.Element {
  // Headers - color the # markers and text
  if (line.startsWith("### ")) {
    return <><span class="syntax-header-marker">###</span>{highlightInline(line.slice(3))}</>;
  }
  if (line.startsWith("## ")) {
    return <><span class="syntax-header-marker">##</span>{highlightInline(line.slice(2))}</>;
  }
  if (line.startsWith("# ")) {
    return <><span class="syntax-header-marker">#</span>{highlightInline(line.slice(1))}</>;
  }

  // List items - color the marker
  if (/^[-*]\s/.test(line)) {
    return <><span class="syntax-list-marker">{line[0]}</span>{highlightInline(line.slice(1))}</>;
  }

  return highlightInline(line);
}

// Highlight inline elements: `code`, **bold**, *italic*
function highlightInline(text: string): JSX.Element {
  const elements: (string | JSX.Element)[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Find patterns
    const codeMatch = remaining.match(/`([^`]+)`/);
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);
    const italicMatch = remaining.match(/(?<!\*)\*([^*]+)\*(?!\*)/);

    const matches = [
      { type: "code", match: codeMatch, index: codeMatch?.index ?? Infinity },
      { type: "bold", match: boldMatch, index: boldMatch?.index ?? Infinity },
      { type: "italic", match: italicMatch, index: italicMatch?.index ?? Infinity },
    ].filter((m) => m.match !== null);

    if (matches.length === 0) {
      if (remaining) elements.push(remaining);
      break;
    }

    matches.sort((a, b) => a.index - b.index);
    const first = matches[0];

    if (first.index > 0) {
      elements.push(remaining.slice(0, first.index));
    }

    const fullMatch = first.match![0];

    if (first.type === "code") {
      elements.push(<span class="syntax-code">{fullMatch}</span>);
    } else if (first.type === "bold") {
      elements.push(<span class="syntax-bold">{fullMatch}</span>);
    } else if (first.type === "italic") {
      elements.push(<span class="syntax-italic">{fullMatch}</span>);
    }

    remaining = remaining.slice(first.index + fullMatch.length);
  }

  return <>{elements}</>;
}

export function Scratchpad(props: Props) {
  const [content, setContent] = createSignal("");
  let textareaRef: HTMLTextAreaElement | undefined;
  let highlightRef: HTMLPreElement | undefined;

  // Load from localStorage on mount
  onMount(() => {
    const saved = localStorage.getItem("scratchpad-content");
    if (saved) setContent(saved);
  });

  // Persist to localStorage (debounced slightly by reactive batching)
  createEffect(() => {
    localStorage.setItem("scratchpad-content", content());
  });

  // Focus textarea when opened
  createEffect(() => {
    if (props.open && textareaRef) {
      setTimeout(() => textareaRef?.focus(), 50);
    }
  });

  // Sync scroll between textarea and highlight layer
  const handleScroll = () => {
    if (textareaRef && highlightRef) {
      highlightRef.scrollTop = textareaRef.scrollTop;
      highlightRef.scrollLeft = textareaRef.scrollLeft;
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // Close on Escape
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  // Handle paste - check for images and save them
  const handlePaste = async (e: ClipboardEvent) => {
    const clipboardData = e.clipboardData;
    if (!hasImageInClipboard(clipboardData)) return;

    // Prevent default paste behavior for images
    e.preventDefault();

    try {
      // Save image via Tauri backend (same as terminal paste)
      const path = await invoke<string>("save_clipboard_image");

      // Insert the path at cursor position
      if (textareaRef) {
        const start = textareaRef.selectionStart;
        const end = textareaRef.selectionEnd;
        const current = content();
        const imageRef = `[image: ${path}]`;
        const newContent = current.slice(0, start) + imageRef + current.slice(end);
        setContent(newContent);

        // Move cursor after inserted text
        const newPos = start + imageRef.length;
        setTimeout(() => {
          textareaRef?.setSelectionRange(newPos, newPos);
        }, 0);
      }
    } catch (err) {
      console.warn("[scratchpad] save_clipboard_image failed", err);
    }
  };

  // Render highlighted content (same text, with syntax coloring)
  const highlightedContent = () => {
    const lines = content().split("\n");
    // Add trailing newline to match textarea behavior
    return (
      <>
        <For each={lines}>
          {(line, i) => (
            <>
              {highlightLine(line)}
              {i() < lines.length - 1 ? "\n" : ""}
            </>
          )}
        </For>
        {/* Extra space to match textarea scrollable area */}
        {"\n"}
      </>
    );
  };

  return (
    <div class={`scratchpad-drawer ${props.open ? "open" : ""}`}>
      <div class="scratchpad-header">
        <span class="scratchpad-title">Scratchpad</span>
        <button class="scratchpad-close" onClick={props.onClose} title="Close (Esc)">
          ×
        </button>
      </div>
      <div class="scratchpad-body">
        <pre ref={highlightRef} class="scratchpad-highlight" aria-hidden="true">
          {highlightedContent()}
        </pre>
        <textarea
          ref={textareaRef}
          class="scratchpad-textarea"
          value={content()}
          onInput={(e) => setContent(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onScroll={handleScroll}
          placeholder="Notes, commands, thoughts..."
          spellcheck={false}
        />
      </div>
    </div>
  );
}

