/**
 * Registers the service worker (`web/static/sw.js`), which makes the client
 * installable, opens it offline and receives shares.
 *
 * @module
 */

/** Register the service worker once the page has loaded. Never throws. */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !globalThis.isSecureContext) return;
  const register = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(
      (error) => console.warn("service worker not registered:", error),
    );
  };
  if (document.readyState === "complete") register();
  else addEventListener("load", register, { once: true });
}
