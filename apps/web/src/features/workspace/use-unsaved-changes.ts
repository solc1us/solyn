"use client";

import { useEffect } from "react";

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const followLink = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.target === "_blank" ||
        link.hasAttribute("download")
      )
        return;
      if (link.href === window.location.href || link.getAttribute("href")?.startsWith("#")) return;
      if (!window.confirm("Leave this page? Your unsaved changes will be lost.")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Use the public browser API where available; do not patch Next's history.
    const onTraverse = (event: NavigateEvent) => {
      if (
        event.navigationType !== "traverse" ||
        !event.destination.sameDocument ||
        !event.cancelable
      )
        return;
      if (!window.confirm("Leave this page? Your unsaved changes will be lost."))
        event.preventDefault();
    };
    window.navigation?.addEventListener("navigate", onTraverse);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", followLink, true);
    return () => {
      window.navigation?.removeEventListener("navigate", onTraverse);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", followLink, true);
    };
  }, [dirty]);
}
