import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useAppContext } from "../../app/context/AppContext";
import { inferImageMimeType } from "../../utils/clipboard";

type Point = {
  x: number;
  y: number;
};

type Stroke = {
  color: string;
  size: number;
  points: Point[];
};

type TextItem = {
  text: string;
  x: number;
  y: number;
  color: string;
  size: number;
  font: string;
};

type Action =
  | { type: "stroke"; stroke: Stroke }
  | { type: "text"; text: TextItem };

type TextDraft = {
  canvasX: number;
  canvasY: number;
  screenX: number;
  screenY: number;
  scale: number;
};

const DEFAULT_FONT = "SF Pro Text, system-ui, sans-serif";
const SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function ImageEditorModal() {
  const app = useAppContext();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [tool, setTool] = createSignal<"pen" | "text">("pen");
  const [color, setColor] = createSignal("#f97316");
  const [penSize, setPenSize] = createSignal(6);
  const [textSize, setTextSize] = createSignal(20);
  const [actions, setActions] = createSignal<Action[]>([]);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [canEdit, setCanEdit] = createSignal(false);
  const [textDraft, setTextDraft] = createSignal<TextDraft | null>(null);
  const [textValue, setTextValue] = createSignal("");
  let canvasRef: HTMLCanvasElement | undefined;
  let textInputRef: HTMLInputElement | undefined;
  let baseImage: HTMLImageElement | null = null;
  let imageUrl: string | null = null;
  let currentStroke: Stroke | null = null;
  let isDrawing = false;

  const activePath = () => app.imageEditorPath();
  const activeName = () =>
    app.imageEditorName() ?? activePath()?.split("/").pop() ?? "Image";

  const sizeValue = () => (tool() === "text" ? textSize() : penSize());
  const setSizeValue = (value: number) => {
    if (tool() === "text") {
      setTextSize(value);
    } else {
      setPenSize(value);
    }
  };
  const sizeMin = () => (tool() === "text" ? 10 : 2);
  const sizeMax = () => (tool() === "text" ? 48 : 24);

  const resetDraft = () => {
    setTextDraft(null);
    setTextValue("");
  };

  const drawStroke = (ctx: CanvasRenderingContext2D, stroke: Stroke) => {
    const { points } = stroke;
    if (points.length === 0) return;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    if (points.length === 1) {
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  };

  const drawText = (ctx: CanvasRenderingContext2D, text: TextItem) => {
    ctx.fillStyle = text.color;
    ctx.font = `${text.size}px ${text.font}`;
    ctx.textBaseline = "top";
    ctx.fillText(text.text, text.x, text.y);
  };

  const redrawCanvas = (previewStroke?: Stroke | null) => {
    const canvas = canvasRef;
    if (!canvas || !baseImage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseImage, 0, 0);
    for (const action of actions()) {
      if (action.type === "stroke") {
        drawStroke(ctx, action.stroke);
      } else {
        drawText(ctx, action.text);
      }
    }
    if (previewStroke) {
      drawStroke(ctx, previewStroke);
    }
  };

  const getCanvasPoint = (event: PointerEvent | MouseEvent) => {
    const canvas = canvasRef;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const scale = (scaleX + scaleY) / 2;
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    return {
      canvasX: offsetX * scaleX,
      canvasY: offsetY * scaleY,
      screenX: offsetX,
      screenY: offsetY,
      scale,
    };
  };

  const beginTextDraft = (event: PointerEvent | MouseEvent) => {
    if (!canEdit() || loading() || saving()) return;
    if (textDraft()) return;
    const point = getCanvasPoint(event);
    if (!point) return;
    setTextDraft({
      canvasX: point.canvasX,
      canvasY: point.canvasY,
      screenX: point.screenX,
      screenY: point.screenY,
      scale: point.scale,
    });
    setTextValue("");
    requestAnimationFrame(() => {
      textInputRef?.focus();
      textInputRef?.select();
    });
  };

  const commitTextDraft = () => {
    const draft = textDraft();
    const value = textValue().trim();
    if (!draft) return false;
    if (value) {
      setActions((prev) => [
        ...prev,
        {
          type: "text",
          text: {
            text: value,
            x: draft.canvasX,
            y: draft.canvasY,
            color: color(),
            size: textSize() * draft.scale,
            font: DEFAULT_FONT,
          },
        },
      ]);
      setDirty(true);
    }
    resetDraft();
    return Boolean(value);
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!canEdit() || loading() || saving()) return;
    if (event.button !== 0) return;
    if (tool() === "text") {
      beginTextDraft(event);
      return;
    }
    if (textDraft()) return;
    const point = getCanvasPoint(event);
    if (!point) return;
    event.preventDefault();
    isDrawing = true;
    currentStroke = {
      color: color(),
      size: penSize() * point.scale,
      points: [{ x: point.canvasX, y: point.canvasY }],
    };
    redrawCanvas(currentStroke);
    canvasRef?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!isDrawing || !currentStroke) return;
    const point = getCanvasPoint(event);
    if (!point) return;
    currentStroke.points.push({ x: point.canvasX, y: point.canvasY });
    redrawCanvas(currentStroke);
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (!isDrawing || !currentStroke) return;
    event.preventDefault();
    setActions((prev) => [...prev, { type: "stroke", stroke: currentStroke! }]);
    setDirty(true);
    currentStroke = null;
    isDrawing = false;
    canvasRef?.releasePointerCapture(event.pointerId);
    redrawCanvas();
  };

  const handleCanvasClick = (event: MouseEvent) => {
    if (tool() !== "text") return;
    beginTextDraft(event);
  };

  const handleUndo = () => {
    if (actions().length === 0) return;
    setActions((prev) => prev.slice(0, -1));
    setDirty(true);
  };

  const handleClear = () => {
    if (actions().length === 0) return;
    setActions([]);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!canEdit() || saving()) return;
    if (textDraft()) {
      commitTextDraft();
      redrawCanvas();
    }
    const path = activePath();
    if (!path || !canvasRef) return;
    setSaving(true);
    try {
      const mime = inferImageMimeType(path);
      const encodeMime = mime && SUPPORTED_MIMES.has(mime) ? mime : "image/png";
      const blob = await new Promise<Blob | null>((resolve) =>
        canvasRef?.toBlob(resolve, encodeMime, encodeMime === "image/jpeg" ? 0.92 : undefined)
      );
      if (!blob) {
        setError("Failed to encode the image.");
        setSaving(false);
        return;
      }
      const buffer = await blob.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      await invoke("write_file_binary", { path, bytes });
      await app.refreshPasteQueueItem(path);
      app.closeImageEditor();
    } catch (err) {
      console.warn("[image-editor] save failed", err);
      setError("Failed to save the image.");
    } finally {
      setSaving(false);
    }
  };

  createEffect(() => {
    const open = app.imageEditorOpen();
    const path = activePath();
    if (!open || !path) {
      return;
    }
    setLoading(true);
    setError(null);
    setActions([]);
    setDirty(false);
    setCanEdit(false);
    setTool("pen");
    resetDraft();
    const mime = inferImageMimeType(path);
    const supportsEncoding = mime ? SUPPORTED_MIMES.has(mime) : false;
    let canceled = false;
    invoke<number[]>("read_file_binary", { path })
      .then((bytes) => {
        if (canceled) return;
        const blob = new Blob([new Uint8Array(bytes)], {
          type: mime ?? "application/octet-stream",
        });
        imageUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (canceled) return;
          baseImage = img;
          if (canvasRef) {
            canvasRef.width = img.naturalWidth || img.width;
            canvasRef.height = img.naturalHeight || img.height;
          }
          redrawCanvas();
          setCanEdit(supportsEncoding);
          if (!supportsEncoding) {
            setError("Editing supports PNG, JPEG, or WebP images.");
          }
          setLoading(false);
        };
        img.onerror = () => {
          if (canceled) return;
          setError("Unable to load this image for editing.");
          setLoading(false);
          setCanEdit(false);
        };
        img.src = imageUrl;
      })
      .catch((err) => {
        if (canceled) return;
        console.warn("[image-editor] load failed", err);
        setError("Failed to load the image.");
        setLoading(false);
        setCanEdit(false);
      });
    onCleanup(() => {
      canceled = true;
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
        imageUrl = null;
      }
      baseImage = null;
      currentStroke = null;
      isDrawing = false;
      setSaving(false);
    });
  });

  createEffect(() => {
    actions();
    redrawCanvas();
  });

  createEffect(() => {
    if (!app.imageEditorOpen()) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (textDraft()) {
        event.preventDefault();
        resetDraft();
        return;
      }
      if (!saving()) {
        app.closeImageEditor();
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  const canInteract = () => canEdit() && !loading() && !saving();
  const canSave = () => canEdit() && dirty() && !saving();
  const footerHint = () => {
    if (loading()) return "Loading image...";
    if (!canEdit()) return "Editing is disabled for this format.";
    return dirty() ? "Edits ready to save." : "Add pen strokes or text to enable saving.";
  };

  return (
    <Show when={app.imageEditorOpen() && app.imageEditorPath()}>
      <div class="modal-overlay" onClick={() => !saving() && app.closeImageEditor()}>
        <div class="image-editor-card" onClick={(e) => e.stopPropagation()}>
          <div class="image-editor-header">
            <div>
              <div class="image-editor-title">Edit Image</div>
              <div class="image-editor-filename">{activeName()}</div>
            </div>
            <button
              class="image-editor-close"
              onClick={() => !saving() && app.closeImageEditor()}
              title="Close"
            >
              x
            </button>
          </div>
          <div class="image-editor-toolbar">
            <div class="image-editor-tool-group">
              <button
                class={`image-editor-tool-btn ${tool() === "pen" ? "active" : ""}`}
                onClick={() => {
                  setTool("pen");
                  resetDraft();
                }}
                disabled={!canInteract()}
              >
                Pen
              </button>
              <button
                class={`image-editor-tool-btn ${tool() === "text" ? "active" : ""}`}
                onClick={() => {
                  setTool("text");
                }}
                disabled={!canInteract()}
              >
                Text
              </button>
            </div>
            <label class="image-editor-control">
              <span>Color</span>
              <input
                type="color"
                value={color()}
                onInput={(e) => setColor(e.currentTarget.value)}
                disabled={!canInteract()}
              />
            </label>
            <label class="image-editor-control">
              <span>{tool() === "text" ? "Text size" : "Pen size"}</span>
              <input
                type="range"
                min={sizeMin()}
                max={sizeMax()}
                value={sizeValue()}
                onInput={(e) => setSizeValue(Number(e.currentTarget.value))}
                disabled={!canInteract()}
              />
            </label>
            <div class="image-editor-actions">
              <button
                class="image-editor-action-btn"
                onClick={handleUndo}
                disabled={!canInteract() || actions().length === 0}
              >
                Undo
              </button>
              <button
                class="image-editor-action-btn"
                onClick={handleClear}
                disabled={!canInteract() || actions().length === 0}
              >
                Clear
              </button>
            </div>
          </div>
          <Show when={error()}>
            <div class="image-editor-error">{error()}</div>
          </Show>
          <div class="image-editor-canvas-wrap">
            <div class="image-editor-canvas-inner">
              <canvas
                ref={(el) => (canvasRef = el)}
                class={`image-editor-canvas ${canInteract() ? "" : "disabled"}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onClick={handleCanvasClick}
              />
              <Show when={textDraft()}>
                {(draft) => (
                  <input
                    ref={(el) => (textInputRef = el)}
                    class="image-editor-text-input"
                    style={{
                      left: `${draft().screenX}px`,
                      top: `${draft().screenY}px`,
                      color: color(),
                      "font-size": `${textSize()}px`,
                      "font-family": DEFAULT_FONT,
                    }}
                    value={textValue()}
                    onInput={(e) => setTextValue(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitTextDraft();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        resetDraft();
                      }
                    }}
                    onBlur={() => {
                      if (textValue().trim()) {
                        commitTextDraft();
                      } else {
                        resetDraft();
                      }
                    }}
                    placeholder="Type..."
                    spellcheck={false}
                  />
                )}
              </Show>
              <Show when={loading()}>
                <div class="image-editor-loading">Loading image...</div>
              </Show>
            </div>
          </div>
          <div class="image-editor-footer">
            <div class="image-editor-footer-hint">{footerHint()}</div>
            <div class="image-editor-footer-actions">
              <button
                class="image-editor-footer-btn"
                onClick={() => !saving() && app.closeImageEditor()}
                disabled={saving()}
              >
                Cancel
              </button>
              <button
                class="image-editor-footer-btn primary"
                onClick={handleSave}
                disabled={!canSave()}
              >
                {saving() ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
