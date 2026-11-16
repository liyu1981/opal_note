import { Suspense, useEffect, useState } from "react";
import { RouterProvider } from "@tanstack/react-router";

import { ConnectionForm, ErrorBoundary } from "./components/ErrorBoundary";
import { SessionExpiredDialog } from "./components/SessionExpiredDialog";
import { ensureSession, sessionExpired } from "./lib/session";
import { router } from "./router";

export default function App() {
  const [session, setSession] = useState<"loading" | "ready" | "required">(
    "loading",
  );
  // Set when a request is rejected after the app was connected. The only
  // recovery is a page reload, so this shows a blocking dialog instead of
  // swapping the whole workspace for the token form.
  const [expired, setExpired] = useState(sessionExpired());

  useEffect(() => {
    let cancelled = false;
    void ensureSession().then((ok) => {
      if (!cancelled) setSession(ok ? "ready" : "required");
    });
    function onUnauthorized() {
      setExpired(true);
    }
    window.addEventListener("opalnote:unauthorized", onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener("opalnote:unauthorized", onUnauthorized);
    };
  }, []);

  if (session === "loading") return <BootScreen />;
  if (session === "required") {
    return (
      <main className="flex h-full min-h-0 items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-md rounded-2xl border border-line bg-paper p-6 shadow-panel">
          <p className="text-[14px] font-semibold uppercase tracking-[0.16em] text-danger">
            Connection required
          </p>
          <h1 className="mt-2 font-serif text-2xl text-ink">
            Sign in to this notebook
          </h1>
          <p className="mt-2 font-mono text-[14px] leading-relaxed text-muted">
            Enter the server token. It is exchanged for an HttpOnly session
            cookie and is never stored in browser JavaScript storage.
          </p>
          <ConnectionForm onConnected={() => setSession("ready")} />
        </div>
      </main>
    );
  }

  return (
    <>
      <ErrorBoundary>
        <Suspense fallback={<BootScreen />}>
          <RouterProvider router={router} />
        </Suspense>
      </ErrorBoundary>
      {expired && <SessionExpiredDialog />}
    </>
  );
}

function BootScreen() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <div className="text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
        <p className="mt-3 font-mono text-[14px] uppercase tracking-[0.2em] text-faint">
          Querying MnesticDB
        </p>
      </div>
    </div>
  );
}
