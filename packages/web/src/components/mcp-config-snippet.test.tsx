import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpConfigSnippet } from "./mcp-config-snippet";

const BUNDLE_PATH = "/absolute/path/to/tools/pm-mcp-server/pm-mcp-server.mjs";

describe("McpConfigSnippet", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("pool variant emits exact .mcp.json with PM_POOL_NAME / PM_POOL_SECRET", () => {
    const { container } = render(
      <McpConfigSnippet poolName="my-team" poolSecret="s3cr3t" apiUrl="http://localhost:3000" />,
    );

    const expected = JSON.stringify(
      {
        mcpServers: {
          "project-management": {
            command: "node",
            args: [BUNDLE_PATH],
            env: {
              PM_API_URL: "http://localhost:3000",
              PM_POOL_NAME: "my-team",
              PM_POOL_SECRET: "s3cr3t",
            },
          },
        },
      },
      null,
      2,
    );

    // The <code> block preserves whitespace; compare its raw textContent
    // (getByText normalizes whitespace and would mangle the multi-line JSON).
    expect(container.querySelector("pre code")?.textContent).toBe(expected);
  });

  it("token variant has PM_API_TOKEN and no pool vars", () => {
    const { container } = render(
      <McpConfigSnippet mode="token" apiToken="tok_abc" apiUrl="http://localhost:3000" />,
    );

    const expected = JSON.stringify(
      {
        mcpServers: {
          "project-management": {
            command: "node",
            args: [BUNDLE_PATH],
            env: {
              PM_API_URL: "http://localhost:3000",
              PM_API_TOKEN: "tok_abc",
            },
          },
        },
      },
      null,
      2,
    );

    expect(container.querySelector("pre code")?.textContent).toBe(expected);
    expect(expected).not.toContain("PM_POOL_NAME");
    expect(expected).not.toContain("PM_POOL_SECRET");
  });

  it("copy fires navigator.clipboard.writeText with the JSON", () => {
    render(
      <McpConfigSnippet poolName="my-team" poolSecret="s3cr3t" apiUrl="http://localhost:3000" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /copy \.mcp\.json/i }));

    const expected = JSON.stringify(
      {
        mcpServers: {
          "project-management": {
            command: "node",
            args: [BUNDLE_PATH],
            env: {
              PM_API_URL: "http://localhost:3000",
              PM_POOL_NAME: "my-team",
              PM_POOL_SECRET: "s3cr3t",
            },
          },
        },
      },
      null,
      2,
    );

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected);
  });
});
