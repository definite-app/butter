import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import { useAppContext } from "../../app/context/AppContext";
import type { CanvasPoint, CanvasStroke } from "../../app/types";
import "./CanvasView.css";

const distanceBetween = (a: CanvasPoint, b: CanvasPoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);

const drawStroke = (ctx: CanvasRenderingContext2D, stroke: CanvasStroke) => {
  if (stroke.points.length < 2) return;
  const isPen = stroke.tool === "pen";
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = isPen ? "rgba(245, 215, 110, 0.95)" : "rgba(245, 215, 110, 0.45)";
  ctx.lineWidth = isPen ? 2.6 : 1.4;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i += 1) {
    const point = stroke.points[i];
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
  ctx.restore();
};

const canvasDebug = (...args: unknown[]) => {
  if (localStorage.getItem("canvas-debug") === "1") {
    // eslint-disable-next-line no-console
    console.debug("[canvas-debug]", ...args);
  }
};

const isCanvasDragBlockedTarget = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "input, textarea, button, select, pre, img, .canvas-terminal-host, .canvas-file-text, .canvas-open-external"
    )
  );
};

function CanvasImageFromPath(props: { path: string; alt: string; class?: string }) {
  const [url, setUrl] = createSignal<string | null>(null);

  createEffect(() => {
    const path = props.path;
    let disposed = false;
    let objectUrl: string | null = null;
    setUrl(null);

    invoke<number[]>("read_file_binary", { path })
      .then((bytes) => {
        if (disposed) return;
        const ext = path.split(".").pop()?.toLowerCase() || "";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext || "png"}`;
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) setUrl(null);
      });

    onCleanup(() => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
  });

  return (
    <Show when={url()} fallback={<div class="canvas-image-fallback">Image unavailable</div>}>
      {(src) => <img class={props.class || "canvas-image"} src={src()} alt={props.alt} draggable={false} />}
    </Show>
  );
}

function CanvasTerminalHost(props: { sessionId: string }) {
  const app = useAppContext();
  let hostRef: HTMLDivElement | undefined;

  onMount(() => {
    if (hostRef) {
      app.registerTerminalHost(props.sessionId, hostRef);
      setTimeout(() => app.fitTerminalSession(props.sessionId), 0);
    }
  });

  onCleanup(() => {
    app.registerTerminalHost(props.sessionId, undefined);
  });

  return (
    <div
      class="canvas-terminal-host"
      ref={(el) => {
        hostRef = el;
      }}
    />
  );
}

function CanvasObjectCard(props: {
  objectId: string;
  isTerminalMaximized: boolean;
  onToggleTerminalMaximize: (id: string) => void;
}) {
  const app = useAppContext();
  const object = createMemo(() =>
    app.canvasBoard().objects.find((entry) => entry.id === props.objectId)
  );
  const [dragState, setDragState] = createSignal<{
    originX: number;
    originY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const [resizeState, setResizeState] = createSignal<{
    originW: number;
    originH: number;
    startX: number;
    startY: number;
  } | null>(null);
  let fitRaf: number | null = null;

  const scheduleTerminalFit = () => {
    const current = object();
    if (!current || current.type !== "terminal") return;
    const sessionId = current.sessionId;
    if (fitRaf !== null) return;
    fitRaf = requestAnimationFrame(() => {
      fitRaf = null;
      app.fitTerminalSession(sessionId);
    });
  };

  const stopInteractions = () => {
    setDragState(null);
    setResizeState(null);
    scheduleTerminalFit();
  };

  const applyInteraction = (clientX: number, clientY: number) => {
    const zoom = Math.max(0.25, app.canvasBoard().zoom || 1);
    const drag = dragState();
    if (drag) {
      const dx = (clientX - drag.startX) / zoom;
      const dy = (clientY - drag.startY) / zoom;
      canvasDebug("drag-move", props.objectId, { dx, dy, clientX, clientY });
      app.updateCanvasObjectBounds(props.objectId, {
        x: Math.max(8, drag.originX + dx),
        y: Math.max(8, drag.originY + dy),
      });
      return;
    }

    const resize = resizeState();
    if (resize) {
      const dx = (clientX - resize.startX) / zoom;
      const dy = (clientY - resize.startY) / zoom;
      canvasDebug("resize-move", props.objectId, { dx, dy, clientX, clientY });
      app.updateCanvasObjectBounds(props.objectId, {
        w: resize.originW + dx,
        h: resize.originH + dy,
      });
    }
  };

  const handlePointerMove = (event: PointerEvent) => {
    applyInteraction(event.clientX, event.clientY);
  };

  const handleMouseMove = (event: MouseEvent) => {
    applyInteraction(event.clientX, event.clientY);
  };

  const handlePointerUp = () => {
    if (dragState() || resizeState()) {
      canvasDebug("interaction-end", props.objectId);
      stopInteractions();
    }
  };

  const handleMouseUp = () => {
    if (dragState() || resizeState()) {
      canvasDebug("interaction-end(mouse)", props.objectId);
      stopInteractions();
    }
  };

  onMount(() => {
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerUp, true);
    window.addEventListener("mousemove", handleMouseMove, true);
    window.addEventListener("mouseup", handleMouseUp, true);
  });

  onCleanup(() => {
    window.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("pointerup", handlePointerUp, true);
    window.removeEventListener("pointercancel", handlePointerUp, true);
    window.removeEventListener("mousemove", handleMouseMove, true);
    window.removeEventListener("mouseup", handleMouseUp, true);
    if (fitRaf !== null) cancelAnimationFrame(fitRaf);
  });

  const beginDrag = (event: PointerEvent | MouseEvent) => {
    const current = object();
    if (!current) return;
    if (app.canvasBoard().activeTool !== "select") return;
    event.preventDefault();
    event.stopPropagation();
    app.selectCanvasObject(current.id, { bringToFront: false });
    canvasDebug("drag-start(pointer)", current.id, {
      x: current.x,
      y: current.y,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    setDragState({
      originX: current.x,
      originY: current.y,
      startX: event.clientX,
      startY: event.clientY,
    });
  };

  const beginResize = (event: PointerEvent | MouseEvent) => {
    const current = object();
    if (!current) return;
    if (app.canvasBoard().activeTool !== "select") return;
    event.preventDefault();
    event.stopPropagation();
    app.selectCanvasObject(current.id, { bringToFront: false });
    canvasDebug("resize-start(pointer)", current.id, {
      w: current.w,
      h: current.h,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    setResizeState({
      originW: current.w,
      originH: current.h,
      startX: event.clientX,
      startY: event.clientY,
    });
  };

  const objectLabel = () => {
    const current = object();
    if (!current) return "";
    if (current.type === "text") return "Text";
    if (current.type === "image") return current.name;
    if (current.type === "terminal") return `Terminal ${current.sessionId.slice(0, 6)}`;
    return current.name;
  };

  const textObject = () => {
    const current = object();
    return current && current.type === "text" ? current : null;
  };

  const imageObject = () => {
    const current = object();
    return current && current.type === "image" ? current : null;
  };

  const terminalObject = () => {
    const current = object();
    return current && current.type === "terminal" ? current : null;
  };

  const fileObject = () => {
    const current = object();
    return current && current.type === "file" ? current : null;
  };

  return (
    <Show when={object()}>
      <div
        class={`canvas-object-card ${app.canvasBoard().selectedObjectIds.includes(object()?.id || "") ? "selected" : ""}`}
        style={{
          left: `${object()?.x ?? 0}px`,
          top: `${object()?.y ?? 0}px`,
          width: `${object()?.w ?? 0}px`,
          height: `${object()?.h ?? 0}px`,
          "z-index": object()?.z ?? 1,
        }}
        onPointerDown={(event) => {
          if (app.canvasBoard().activeTool !== "select") return;
          event.stopPropagation();
          const obj = object();
          if (!obj) return;
          app.selectCanvasObject(obj.id, { bringToFront: false });
          if (event.button !== 0) return;
          if (isCanvasDragBlockedTarget(event.target)) return;
          event.preventDefault();
          canvasDebug("drag-start(card)", obj.id, {
            x: obj.x,
            y: obj.y,
            clientX: event.clientX,
            clientY: event.clientY,
          });
          setDragState({
            originX: obj.x,
            originY: obj.y,
            startX: event.clientX,
            startY: event.clientY,
          });
        }}
        onMouseDown={(event) => {
          if (app.canvasBoard().activeTool !== "select") return;
          event.stopPropagation();
          const obj = object();
          if (!obj) return;
          app.selectCanvasObject(obj.id, { bringToFront: false });
          if (event.button !== 0) return;
          if (isCanvasDragBlockedTarget(event.target)) return;
          event.preventDefault();
          canvasDebug("drag-start(card-mouse)", obj.id, {
            x: obj.x,
            y: obj.y,
            clientX: event.clientX,
            clientY: event.clientY,
          });
          setDragState({
            originX: obj.x,
            originY: obj.y,
            startX: event.clientX,
            startY: event.clientY,
          });
        }}
      >
        <div class="canvas-object-header" onPointerDown={beginDrag} onMouseDown={beginDrag}>
          <span class="canvas-object-title">{objectLabel()}</span>
          <div class="canvas-object-actions">
            <Show when={terminalObject()}>
              <button
                class="canvas-object-maximize"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleTerminalMaximize(props.objectId);
                }}
                title={props.isTerminalMaximized ? "Restore terminal size" : "Maximize terminal"}
              >
                {props.isTerminalMaximized ? "▢" : "□"}
              </button>
            </Show>
            <button
              class="canvas-object-close"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                app.removeCanvasObject(props.objectId);
              }}
              title="Remove from canvas"
            >
              x
            </button>
          </div>
        </div>
        <div class="canvas-object-content">
          <Show when={textObject()}>
            <textarea
              class="canvas-text-object"
              data-canvas-text-id={props.objectId}
              value={textObject()?.text || ""}
              onInput={(event) => {
                app.updateCanvasTextObject(props.objectId, event.currentTarget.value);
              }}
              onPointerDown={(event) => {
                if (app.canvasBoard().activeTool === "select") {
                  app.selectCanvasObject(props.objectId, { bringToFront: false });
                } else {
                  event.stopPropagation();
                }
              }}
              placeholder="Type on canvas..."
              spellcheck={false}
            />
          </Show>

          <Show when={imageObject()}>
            <CanvasImageFromPath
              path={imageObject()?.path || ""}
              alt={imageObject()?.name || "Canvas image"}
            />
          </Show>

          <Show when={terminalObject()}>
            <CanvasTerminalHost sessionId={terminalObject()?.sessionId || ""} />
          </Show>

          <Show when={fileObject()}>
            <div class="canvas-file-object">
              <div class="canvas-file-path">{fileObject()?.path || ""}</div>
              <Show when={fileObject()?.fileKind === "image"}>
                <CanvasImageFromPath
                  path={fileObject()?.path || ""}
                  alt={fileObject()?.name || "File image"}
                  class="canvas-file-image"
                />
              </Show>
              <Show when={fileObject()?.fileKind === "text"}>
                <pre class="canvas-file-text">{fileObject()?.textContent || ""}</pre>
              </Show>
              <Show when={fileObject()?.fileKind === "binary"}>
                <div class="canvas-file-binary">
                  <span>{fileObject()?.error || "Binary file preview not available."}</span>
                  <button
                    class="canvas-open-external"
                    onClick={() => {
                      const file = fileObject();
                      if (!file) return;
                      void Command.create("open", [file.path]).execute();
                    }}
                  >
                    Open Externally
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </div>
        <div
          class="canvas-resize-handle"
          onPointerDown={beginResize}
          onMouseDown={beginResize}
        />
      </div>
    </Show>
  );
}

export function CanvasView() {
  const app = useAppContext();
  let stageRef: HTMLDivElement | undefined;
  let drawingRef: HTMLCanvasElement | undefined;
  const [draftStroke, setDraftStroke] = createSignal<CanvasStroke | null>(null);
  const [selectionMarquee, setSelectionMarquee] = createSignal<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const [maximizedTerminal, setMaximizedTerminal] = createSignal<{
    id: string;
    prev: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const [stageSize, setStageSize] = createSignal({ width: 1, height: 1 });
  const zoom = createMemo(() => Math.max(0.25, app.canvasBoard().zoom || 1));
  const zoomPct = createMemo(() => Math.round(zoom() * 100));
  const sortedObjectIds = createMemo(() =>
    [...app.canvasBoard().objects].sort((left, right) => left.z - right.z)
      .map((obj) => obj.id)
  );

  const contentExtent = createMemo(() => {
    let maxX = stageSize().width;
    let maxY = stageSize().height;
    for (const obj of app.canvasBoard().objects) {
      maxX = Math.max(maxX, obj.x + obj.w + 80);
      maxY = Math.max(maxY, obj.y + obj.h + 80);
    }
    for (const stroke of app.canvasBoard().strokes) {
      for (const point of stroke.points) {
        maxX = Math.max(maxX, point.x + 80);
        maxY = Math.max(maxY, point.y + 80);
      }
    }
    const draft = draftStroke();
    if (draft) {
      for (const point of draft.points) {
        maxX = Math.max(maxX, point.x + 80);
        maxY = Math.max(maxY, point.y + 80);
      }
    }
    return {
      width: Math.max(400, Math.ceil(maxX)),
      height: Math.max(280, Math.ceil(maxY)),
    };
  });

  const redraw = () => {
    if (!drawingRef || !stageRef) return;
    const ctx = drawingRef.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const world = contentExtent();
    const width = Math.max(1, Math.floor(world.width));
    const height = Math.max(1, Math.floor(world.height));
    if (drawingRef.width !== Math.floor(width * dpr) || drawingRef.height !== Math.floor(height * dpr)) {
      drawingRef.width = Math.floor(width * dpr);
      drawingRef.height = Math.floor(height * dpr);
      drawingRef.style.width = `${width}px`;
      drawingRef.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    for (const stroke of app.canvasBoard().strokes) {
      drawStroke(ctx, stroke);
    }
    const current = draftStroke();
    if (current) drawStroke(ctx, current);
  };

  const pointerToCanvasPoint = (event: PointerEvent): CanvasPoint | null => {
    if (!drawingRef) return null;
    const rect = drawingRef.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (event.clientX - rect.left) / zoom(),
      y: (event.clientY - rect.top) / zoom(),
    };
  };

  const fitCanvasZoom = () => {
    if (!stageRef) return;
    const world = contentExtent();
    const viewportW = Math.max(100, stageRef.clientWidth - 24);
    const viewportH = Math.max(100, stageRef.clientHeight - 24);
    const target = Math.min(viewportW / world.width, viewportH / world.height);
    app.setCanvasZoom(target);
  };

  const addTextObjectWithFocus = () => {
    const id = app.addCanvasTextObject();
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        `textarea[data-canvas-text-id="${id}"]`
      );
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  };

  const toggleTerminalMaximize = (objectId: string) => {
    if (!stageRef) return;
    const obj = app.canvasBoard().objects.find((entry) => entry.id === objectId);
    if (!obj || obj.type !== "terminal") return;

    const current = maximizedTerminal();
    if (current?.id === objectId) {
      app.updateCanvasObjectBounds(objectId, current.prev);
      setMaximizedTerminal(null);
      requestAnimationFrame(() => app.fitTerminalSession(obj.sessionId));
      return;
    }

    if (current) {
      app.updateCanvasObjectBounds(current.id, current.prev);
    }

    const zoomLevel = zoom();
    const inset = 8;
    const x = stageRef.scrollLeft / zoomLevel + inset;
    const y = stageRef.scrollTop / zoomLevel + inset;
    const w = Math.max(280, (stageRef.clientWidth - inset * 2) / zoomLevel);
    const h = Math.max(180, (stageRef.clientHeight - inset * 2) / zoomLevel);

    setMaximizedTerminal({
      id: objectId,
      prev: {
        x: obj.x,
        y: obj.y,
        w: obj.w,
        h: obj.h,
      },
    });
    app.updateCanvasObjectBounds(objectId, { x, y, w, h });
    app.selectCanvasObject(objectId, { bringToFront: true });
    requestAnimationFrame(() => app.fitTerminalSession(obj.sessionId));
  };

  const marqueeBounds = createMemo(() => {
    const marquee = selectionMarquee();
    if (!marquee) return null;
    const left = Math.min(marquee.startX, marquee.currentX);
    const top = Math.min(marquee.startY, marquee.currentY);
    const width = Math.abs(marquee.currentX - marquee.startX);
    const height = Math.abs(marquee.currentY - marquee.startY);
    return { left, top, width, height };
  });

  const handleDrawingPointerDown = (event: PointerEvent) => {
    if (app.canvasBoard().activeTool === "select") return;
    if (event.button !== 0) return;
    const point = pointerToCanvasPoint(event);
    if (!point) return;
    event.preventDefault();
    setDraftStroke({
      tool: "pen",
      points: [point],
    });
  };

  const handleDrawingPointerMove = (event: PointerEvent) => {
    const current = draftStroke();
    if (!current) return;
    const point = pointerToCanvasPoint(event);
    if (!point) return;
    const last = current.points[current.points.length - 1];
    if (distanceBetween(last, point) < 0.5) return;
    setDraftStroke({
      ...current,
      points: [...current.points, point],
    });
  };

  const handleSelectionPointerMove = (event: PointerEvent) => {
    const marquee = selectionMarquee();
    if (!marquee) return;
    const point = pointerToCanvasPoint(event);
    if (!point) return;
    setSelectionMarquee({
      ...marquee,
      currentX: point.x,
      currentY: point.y,
    });
  };

  const commitDraftStroke = () => {
    const current = draftStroke();
    if (current && current.points.length > 1) {
      app.addCanvasStroke(current);
    }
    setDraftStroke(null);
  };

  const commitSelectionMarquee = () => {
    const marquee = selectionMarquee();
    if (!marquee) return;
    setSelectionMarquee(null);
    const left = Math.min(marquee.startX, marquee.currentX);
    const top = Math.min(marquee.startY, marquee.currentY);
    const right = Math.max(marquee.startX, marquee.currentX);
    const bottom = Math.max(marquee.startY, marquee.currentY);
    if (Math.abs(right - left) < 2 && Math.abs(bottom - top) < 2) {
      app.setCanvasSelectedObjects([]);
      return;
    }
    const selectedIds = app.canvasBoard().objects
      .filter((obj) => obj.x < right && obj.x + obj.w > left && obj.y < bottom && obj.y + obj.h > top)
      .map((obj) => obj.id);
    app.setCanvasSelectedObjects(selectedIds);
  };

  const beginSelectionMarquee = (event: PointerEvent) => {
    if (app.canvasBoard().activeTool !== "select") return;
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".canvas-object-card")) return;
    const point = pointerToCanvasPoint(event);
    if (!point) return;
    event.preventDefault();
    app.setCanvasSelectedObjects([]);
    setSelectionMarquee({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    });
  };

  onMount(() => {
    const handlePointerMove = (event: PointerEvent) => {
      handleDrawingPointerMove(event);
      handleSelectionPointerMove(event);
    };
    const handlePointerUp = () => {
      commitDraftStroke();
      commitSelectionMarquee();
    };
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerUp, true);

    const observer = new ResizeObserver(() => {
      if (stageRef) {
        setStageSize({
          width: Math.max(1, Math.floor(stageRef.clientWidth)),
          height: Math.max(1, Math.floor(stageRef.clientHeight)),
        });
      }
      redraw();
    });
    if (stageRef) observer.observe(stageRef);
    if (stageRef) {
      setStageSize({
        width: Math.max(1, Math.floor(stageRef.clientWidth)),
        height: Math.max(1, Math.floor(stageRef.clientHeight)),
      });
    }
    redraw();

    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerUp, true);
    });
  });

  createEffect(() => {
    app.canvasBoard();
    contentExtent();
    zoom();
    draftStroke();
    redraw();
  });

  createEffect(() => {
    const current = maximizedTerminal();
    if (!current) return;
    const exists = app.canvasBoard().objects.some((obj) => obj.id === current.id);
    if (!exists) {
      setMaximizedTerminal(null);
    }
  });

  return (
    <main class="canvas-main">
      <div class="canvas-topbar">
        <div class="canvas-topbar-left">
          <div class="canvas-top-tools">
            <button
              class={`canvas-top-tool ${app.canvasBoard().activeTool === "select" ? "active" : ""}`}
              onClick={() => app.setCanvasTool("select")}
              title="Select / move objects"
            >
              Select
            </button>
            <button
              class="canvas-top-tool"
              onClick={addTextObjectWithFocus}
              title="Add text object"
            >
              Text
            </button>
            <button
              class={`canvas-top-tool ${app.canvasBoard().activeTool === "pen" ? "active" : ""}`}
              onClick={() => app.setCanvasTool("pen")}
              title="Pen tool"
            >
              Pen
            </button>
          </div>
        </div>
        <div class="canvas-zoom-controls">
          <button class="canvas-zoom-btn" onClick={() => app.zoomOutCanvas()} title="Zoom out (Cmd -)">
            -
          </button>
          <span class="canvas-zoom-value">{zoomPct()}%</span>
          <button class="canvas-zoom-btn" onClick={() => app.zoomInCanvas()} title="Zoom in (Cmd +)">
            +
          </button>
          <div class="canvas-zoom-select-wrap">
            <select
              class="canvas-zoom-select"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "fit") {
                  fitCanvasZoom();
                  event.currentTarget.value = "";
                  return;
                }
                const parsed = Number(value);
                if (Number.isFinite(parsed)) {
                  app.setCanvasZoom(parsed / 100);
                }
              }}
            >
              <option value="">Zoom Presets</option>
              <option value="fit">Fit</option>
              <option value="50">50%</option>
              <option value="75">75%</option>
              <option value="100">100%</option>
              <option value="125">125%</option>
              <option value="150">150%</option>
              <option value="200">200%</option>
            </select>
            <span class="canvas-zoom-caret">▾</span>
          </div>
        </div>
      </div>
      <div
        class="canvas-stage"
        ref={(el) => {
          stageRef = el;
        }}
        onPointerDown={(event) => {
          app.setCanvasContextMenu(null);
          if (app.canvasBoard().activeTool === "select") {
            beginSelectionMarquee(event);
            return;
          }
          if (event.target === event.currentTarget || event.target === drawingRef) {
            app.selectCanvasObject(null);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          app.setContextMenuFor(null);
          app.setSidebarContextMenu(null);
          app.setFolderContextMenu(null);
          app.setCanvasContextMenu({
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        <div
          class="canvas-world"
          style={{
            width: `${contentExtent().width}px`,
            height: `${contentExtent().height}px`,
            transform: `scale(${zoom()})`,
          }}
        >
          <canvas
            class={`canvas-drawing-layer ${app.canvasBoard().activeTool === "select" ? "disabled" : ""}`}
            ref={(el) => {
              drawingRef = el;
            }}
            onPointerDown={handleDrawingPointerDown}
          />
          <div class="canvas-objects-layer">
            <For each={sortedObjectIds()}>
              {(objectId) => (
                <CanvasObjectCard
                  objectId={objectId}
                  isTerminalMaximized={maximizedTerminal()?.id === objectId}
                  onToggleTerminalMaximize={toggleTerminalMaximize}
                />
              )}
            </For>
          </div>
          <Show when={marqueeBounds()}>
            {(bounds) => (
              <div
                class="canvas-selection-marquee"
                style={{
                  left: `${bounds().left}px`,
                  top: `${bounds().top}px`,
                  width: `${bounds().width}px`,
                  height: `${bounds().height}px`,
                }}
              />
            )}
          </Show>
        </div>
      </div>
    </main>
  );
}
