/**
 * The application root: shell plus the view of the current route.
 *
 * @module
 */
import { Shell } from "./components/Shell.tsx";
import { useRoute } from "./lib/router.tsx";
import { VIEWS } from "./routes.ts";

/** Renders the view for the current route inside the shell. */
export function App() {
  const route = useRoute();
  const View = VIEWS[route.name];
  return (
    <Shell>
      <View key={route.pathname} />
    </Shell>
  );
}
