import { useEffect, useState } from "react";
import { CalendarApp } from "./ui/CalendarApp";
import { createAppRuntime, startAppStore } from "./ui/connect";

/** Calendar app entry: one store per window, loaded once, watching agent proposals. */
export default function App() {
  const [runtime] = useState(createAppRuntime);
  const { store, getFreeBusy } = runtime;
  useEffect(() => startAppStore(store), [store]);
  return <CalendarApp store={store} getFreeBusy={getFreeBusy} />;
}
