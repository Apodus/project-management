import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// The legend wraps its card in a ReactFlow <Panel>, which needs the flow store
// context. Stub Panel to a passthrough so the legend can render standalone.
vi.mock("@xyflow/react", () => ({
  Panel: ({ children }: { children?: ReactNode }) => <div data-testid="panel">{children}</div>,
}));

import { CategoryLegend } from "./category-legend";

const rows = [
  { key: "Graphics", name: "Graphics", color: "#3b82f6" },
  { key: "__uncategorized__", name: "Uncategorized", color: undefined },
];

describe("CategoryLegend", () => {
  it("returns null when there are no rows", () => {
    const { container } = render(
      <CategoryLegend rows={[]} hidden={new Set()} onToggle={() => {}} />,
    );
    expect(container.querySelector('[data-testid="panel"]')).toBeNull();
  });

  it("renders a toggle row per category with a swatch and label", () => {
    render(<CategoryLegend rows={rows} hidden={new Set()} onToggle={() => {}} />);
    const gfx = screen.getByRole("button", { name: "Graphics" });
    expect(gfx).toHaveAttribute("aria-pressed", "true");
    // Swatch carries the category color.
    expect(gfx.querySelector("span")).toHaveStyle({ backgroundColor: "#3b82f6" });
    expect(screen.getByRole("button", { name: "Uncategorized" })).toBeInTheDocument();
  });

  it("calls onToggle with the row key when a row is clicked", () => {
    const onToggle = vi.fn();
    render(<CategoryLegend rows={rows} hidden={new Set()} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Graphics" }));
    expect(onToggle).toHaveBeenCalledWith("Graphics");
  });

  it("strikes through a hidden row and marks it unpressed", () => {
    render(<CategoryLegend rows={rows} hidden={new Set(["Graphics"])} onToggle={() => {}} />);
    const gfx = screen.getByRole("button", { name: "Graphics" });
    expect(gfx).toHaveAttribute("aria-pressed", "false");
    expect(gfx.querySelector("span:last-child")).toHaveClass("line-through");
  });
});
