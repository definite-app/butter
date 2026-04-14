import { For, createMemo } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";
import { QuickInputGrid } from "./QuickInputGrid";

export function TerminalStack() {
  const app = useAppContext();
  const gridCount = createMemo(() => {
    if (app.quickInputActive()) {
      return Math.max(app.quickViewSessionIds().length, 1);
    }
    return Math.max(app.sessions.length, 1);
  });
  const gridCols = createMemo(() => Math.min(Math.ceil(Math.sqrt(gridCount())), 4));

  return (
    <div
      class="butter-web-terminal-stack"
      style={{
        "--terminal-count": app.sessions.length,
        "--grid-cols": gridCols(),
      }}
    >
      <For each={app.sessions}>
        {(session, index) => (
          <div
            class={`butter-web-terminal ${app.activeSessionId() === session.id ? "active" : ""}`}
            style={{ "--stagger-index": index() }}
          >
            <div
              class="butter-web-terminal-inner"
              ref={(el) => app.registerTerminalHost(session.id, el || undefined)}
            />
          </div>
        )}
      </For>
      <QuickInputGrid />
    </div>
  );
}
