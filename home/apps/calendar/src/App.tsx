import { useEffect, useState } from "react";
import { CalendarApp } from "./ui/CalendarApp";
import { createAppStore, startAppStore } from "./ui/connect";

/** Calendar app entry: one store per window, loaded once, watching agent proposals. */
export default function App() {
  const [store] = useState(createAppStore);
  useEffect(() => startAppStore(store), [store]);
  return <CalendarApp store={store} />;
}
