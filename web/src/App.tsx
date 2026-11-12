import { Suspense } from "react";
import { RouterProvider } from "@tanstack/react-router";

import { ErrorBoundary } from "./components/ErrorBoundary";
import { router } from "./router";

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<BootScreen />}>
        <RouterProvider router={router} />
      </Suspense>
    </ErrorBoundary>
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
