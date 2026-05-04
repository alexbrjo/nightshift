import { useEffect } from "react";

type Cleanup = void | (() => void);
type SetupRefresh = () => Cleanup | Promise<Cleanup>;

interface UseActiveRefreshOptions {
  isActive: boolean;
  refresh: () => void | Promise<void>;
  intervalMs?: number;
  setup?: SetupRefresh;
  refreshToken?: unknown;
}

export function useActiveRefresh({
  isActive,
  refresh,
  intervalMs,
  setup,
  refreshToken,
}: UseActiveRefreshOptions) {
  useEffect(() => {
    if (!isActive) return;

    let cancelled = false;
    let cleanupSetup: Cleanup;
    const cleanupInterval = intervalMs
      ? window.setInterval(() => {
          void refresh();
        }, intervalMs)
      : null;

    void refresh();

    if (setup) {
      void Promise.resolve(setup())
        .then((cleanup) => {
          if (cancelled) {
            cleanup?.();
          } else {
            cleanupSetup = cleanup;
          }
        })
        .catch((error) => {
          console.error("Failed to set up active refresh:", error);
        });
    }

    return () => {
      cancelled = true;
      if (cleanupInterval !== null) window.clearInterval(cleanupInterval);
      cleanupSetup?.();
    };
  }, [isActive, refresh, intervalMs, setup, refreshToken]);
}
