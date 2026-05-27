import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/stores/connection-store";

const BADGE_SIZE = 9;
const FAVICON_SIZE = 32;

/**
 * Draws a notification badge on the favicon when unreadCount > 0.
 * Restores the original favicon when the count drops to zero or
 * the tab regains focus.
 */
export function useFaviconBadge(): void {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const originalHrefRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imgLoadedRef = useRef(false);

  useEffect(() => {
    // Grab or create the favicon <link> element
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }

    // Store the original favicon href (may be empty for default)
    originalHrefRef.current = link.href || null;

    // Create an offscreen canvas
    const canvas = document.createElement("canvas");
    canvas.width = FAVICON_SIZE;
    canvas.height = FAVICON_SIZE;
    canvasRef.current = canvas;

    // Pre-load the original favicon image
    if (originalHrefRef.current) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        imgLoadedRef.current = true;
      };
      img.src = originalHrefRef.current;
      imgRef.current = img;
    }

    // Subscribe to unreadCount changes
    const unsub = useConnectionStore.subscribe((state, prev) => {
      if (state.unreadCount === prev.unreadCount) return;
      updateFavicon(state.unreadCount);
    });

    function updateFavicon(count: number) {
      const cvs = canvasRef.current;
      if (!cvs) return;
      const ctx = cvs.getContext("2d");
      if (!ctx) return;

      const faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!faviconLink) return;

      if (count === 0) {
        // Restore original
        if (originalHrefRef.current) {
          faviconLink.href = originalHrefRef.current;
        }
        return;
      }

      // Clear canvas
      ctx.clearRect(0, 0, FAVICON_SIZE, FAVICON_SIZE);

      // Draw original favicon if loaded
      if (imgRef.current && imgLoadedRef.current) {
        ctx.drawImage(imgRef.current, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
      } else {
        // Fallback: draw a simple document icon
        ctx.fillStyle = "#6366f1";
        ctx.beginPath();
        ctx.roundRect(2, 2, 28, 28, 4);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 18px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("P", 16, 17);
      }

      // Draw badge circle (top-right)
      const badgeX = FAVICON_SIZE - BADGE_SIZE;
      const badgeY = 0;
      const badgeR = BADGE_SIZE;

      ctx.beginPath();
      ctx.arc(badgeX, badgeY + badgeR, badgeR, 0, 2 * Math.PI);
      ctx.fillStyle = "#ef4444";
      ctx.fill();

      // Badge text
      const label = count > 9 ? "9+" : String(count);
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${count > 9 ? 9 : 11}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, badgeX, badgeY + badgeR + 1);

      // Apply
      faviconLink.href = cvs.toDataURL("image/png");
    }

    return () => {
      unsub();
      // Restore original favicon on cleanup
      const faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (faviconLink && originalHrefRef.current) {
        faviconLink.href = originalHrefRef.current;
      }
    };
  }, []);
}
