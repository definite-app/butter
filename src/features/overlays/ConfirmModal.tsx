import { Show, createEffect, onCleanup } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

export function ConfirmModal() {
  const app = useAppContext();

  createEffect(() => {
    const state = app.confirmDialog();
    if (!state) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        app.resolveConfirmDialog(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        app.resolveConfirmDialog(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  });

  return (
    <Show when={app.confirmDialog()}>
      {(state) => (
        <div
          class="modal-overlay"
          onClick={() => app.resolveConfirmDialog(false)}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            class="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`confirm-title-${state().id}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div id={`confirm-title-${state().id}`} class="confirm-modal-title">
              {state().title}
            </div>
            <div class="confirm-modal-body">{state().message}</div>
            <div class="confirm-modal-actions">
              <button
                class="confirm-modal-btn"
                type="button"
                onClick={() => app.resolveConfirmDialog(false)}
              >
                {state().cancelLabel}
              </button>
              <button
                class={`confirm-modal-btn primary ${state().destructive ? "destructive" : ""}`}
                type="button"
                ref={(el) => {
                  if (el) requestAnimationFrame(() => el.focus());
                }}
                onClick={() => app.resolveConfirmDialog(true)}
              >
                {state().confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
