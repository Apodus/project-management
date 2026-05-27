import { useEffect } from "react";
import { useConnectionStore } from "@/stores/connection-store";

const BASE_TITLE = "Project Management";

/**
 * Prefixes the document title with the unread count when > 0.
 * Restores the normal title when count drops to zero.
 */
export function useDocumentTitle(): void {
  const unreadCount = useConnectionStore((s) => s.unreadCount);

  useEffect(() => {
    document.title =
      unreadCount > 0 ? `(${unreadCount}) ${BASE_TITLE}` : BASE_TITLE;
  }, [unreadCount]);
}
