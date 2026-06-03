import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

// Default anchor + size for the floating panel. `null` state keeps this nice
// top-right default; the first drag/resize switches to controlled left/top.
const DEFAULT_RIGHT = 16;
const DEFAULT_TOP = 16;
const DEFAULT_WIDTH = 384; // w-96
const DEFAULT_HEIGHT = 448; // h-[28rem]
const MIN_WIDTH = 280;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 720;
const MAX_HEIGHT = 640;

interface DragStart {
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
}

interface ResizeStart {
  startX: number;
  startY: number;
  startW: number;
  startH: number;
}

interface PointerHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
}

export interface FloatingPanel {
  panelRef: React.RefObject<HTMLDivElement | null>;
  style: CSSProperties;
  dragHandleProps: PointerHandlers;
  resizeHandleProps: PointerHandlers;
}

/**
 * Turns a Card into a movable, resizable window via pointer capture + React
 * state. The "null = default" pattern preserves the declarative top-right
 * anchor until the user first interacts; `ensurePositioned` reads the live rect
 * (relative to the offsetParent) so resize grows right/down intuitively rather
 * than leftward from the right-anchor.
 */
export function useFloatingPanel(): FloatingPanel {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const dragStart = useRef<DragStart | null>(null);
  const resizeStart = useRef<ResizeStart | null>(null);

  // On first interaction, freeze the current rendered position into left/top so
  // subsequent updates are absolute rather than fighting the right-anchor.
  const ensurePositioned = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    setPos((cur) => cur ?? { left: el.offsetLeft, top: el.offsetTop });
  }, []);

  // ── Drag (from the header) ─────────────────────────────────────
  const onDragDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return; // primary button only
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return; // let buttons/links work
      const el = panelRef.current;
      if (!el) return;
      ensurePositioned();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStart.current = {
        startX: e.clientX,
        startY: e.clientY,
        startLeft: el.offsetLeft,
        startTop: el.offsetTop,
      };
    },
    [ensurePositioned],
  );

  const onDragMove = useCallback((e: ReactPointerEvent) => {
    const start = dragStart.current;
    const el = panelRef.current;
    if (!start || !el) return;
    const parent = el.offsetParent as HTMLElement | null;
    let left = start.startLeft + (e.clientX - start.startX);
    let top = start.startTop + (e.clientY - start.startY);
    // Light clamp: keep the header reachable inside the offsetParent.
    if (parent) {
      const headerH = 40;
      left = Math.max(0, Math.min(left, parent.clientWidth - el.offsetWidth));
      top = Math.max(0, Math.min(top, parent.clientHeight - headerH));
    }
    setPos({ left, top });
  }, []);

  const onDragUp = useCallback((e: ReactPointerEvent) => {
    dragStart.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  // ── Resize (bottom-right grip) ─────────────────────────────────
  const onResizeDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const el = panelRef.current;
      if (!el) return;
      e.stopPropagation();
      ensurePositioned();
      e.currentTarget.setPointerCapture(e.pointerId);
      resizeStart.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: el.offsetWidth,
        startH: el.offsetHeight,
      };
    },
    [ensurePositioned],
  );

  const onResizeMove = useCallback((e: ReactPointerEvent) => {
    const start = resizeStart.current;
    if (!start) return;
    setSize({
      w: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, start.startW + (e.clientX - start.startX))),
      h: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, start.startH + (e.clientY - start.startY))),
    });
  }, []);

  const onResizeUp = useCallback((e: ReactPointerEvent) => {
    resizeStart.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const style: CSSProperties = {
    position: "absolute",
    zIndex: 10,
    top: pos ? pos.top : DEFAULT_TOP,
    left: pos ? pos.left : undefined,
    right: pos ? undefined : DEFAULT_RIGHT,
    width: size ? size.w : DEFAULT_WIDTH,
    height: size ? size.h : DEFAULT_HEIGHT,
  };

  return {
    panelRef,
    style,
    dragHandleProps: {
      onPointerDown: onDragDown,
      onPointerMove: onDragMove,
      onPointerUp: onDragUp,
      onPointerCancel: onDragUp,
    },
    resizeHandleProps: {
      onPointerDown: onResizeDown,
      onPointerMove: onResizeMove,
      onPointerUp: onResizeUp,
      onPointerCancel: onResizeUp,
    },
  };
}
