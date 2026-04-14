import { createContext, useContext } from "solid-js";
import type { ParentProps } from "solid-js";
import { useAppModel } from "../useAppModel";

export type AppModel = ReturnType<typeof useAppModel>;

const AppContext = createContext<AppModel>();

export function AppProvider(props: ParentProps) {
  const model = useAppModel();
  return <AppContext.Provider value={model}>{props.children}</AppContext.Provider>;
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("AppContext not available");
  }
  return ctx;
}
