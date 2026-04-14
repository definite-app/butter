import { AppProvider } from "./app/context/AppContext";
import { AppShell } from "./app/AppShell";

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
