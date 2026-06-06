import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ClaimStateBadge } from "./claim-state-badge";

describe("ClaimStateBadge", () => {
  it("renders an amber 'Stale' badge for state=stale", () => {
    const { container } = render(<ClaimStateBadge state="stale" />);
    expect(screen.getByText("Stale")).toBeInTheDocument();
    // The amber soft-tint is the dominant affordance — assert it is applied.
    const badge = container.querySelector('[data-slot="badge"]');
    expect(badge?.className).toContain("bg-amber-100");
  });

  it("renders nothing for state=unclaimed", () => {
    const { container } = render(<ClaimStateBadge state="unclaimed" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a 'Live' badge for state=live", () => {
    render(<ClaimStateBadge state="live" />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("renders a 'Yours' badge for state=yours", () => {
    render(<ClaimStateBadge state="yours" />);
    expect(screen.getByText("Yours")).toBeInTheDocument();
  });

  it("forwards className onto the rendered badge", () => {
    const { container } = render(
      <ClaimStateBadge state="stale" className="custom-x" />,
    );
    const badge = container.querySelector('[data-slot="badge"]');
    expect(badge?.className).toContain("custom-x");
  });
});
