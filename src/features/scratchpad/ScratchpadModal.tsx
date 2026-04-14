import { Scratchpad } from "../../Scratchpad";
import { useAppContext } from "../../app/context/AppContext";

export function ScratchpadModal() {
  const app = useAppContext();

  return (
    <Scratchpad
      open={app.scratchpadOpen()}
      onClose={() => {
        app.setScratchpadOpen(false);
        const activeId = app.activeSessionId();
        if (activeId) {
          app.focusTerminal(activeId);
        }
      }}
    />
  );
}
