import { Show } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

export function RestorePrompt() {
  const app = useAppContext();

  return (
    <Show when={app.restorePromptOpen()}>
      <div class="modal-overlay">
        <div class="session-restore-card" onClick={(e) => e.stopPropagation()}>
          <div class="session-restore-title">Restore previous sessions?</div>
          <div class="session-restore-body">
            We found {app.sessions.length} session{app.sessions.length === 1 ? "" : "s"} from your last run.
            Do you want to reopen them now?
          </div>
          <div class="session-restore-actions">
            <button class="session-restore-btn" onClick={app.declineRestoreSessions}>
              No
            </button>
            <button class="session-restore-btn primary" onClick={app.confirmRestoreSessions}>
              Yes
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
