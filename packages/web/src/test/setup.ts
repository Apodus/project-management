import { expect, afterEach, vi } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

// ── jsdom shims for Radix UI primitives (Select et al.) ──────────
// jsdom lacks pointer-capture + scrollIntoView, which Radix's Select uses
// when opening/keyboard-navigating. Without these the trigger never opens and
// options aren't clickable. General-purpose — benefits any Select-driven test.
// Guarded so a real implementation (e.g. happy-dom) is never clobbered.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = vi.fn();
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
if (typeof window.PointerEvent === "undefined") {
  // Minimal PointerEvent shim so Radix's pointer-driven open path works.
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
    }
  } as unknown as typeof window.PointerEvent;
}

// ── ResizeObserver polyfill (React Flow / ReactFlowProvider) ──────
// jsdom has no ResizeObserver; React Flow's store observes its container on
// mount. A no-op shim is sufficient for component tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof globalThis.ResizeObserver;
}
