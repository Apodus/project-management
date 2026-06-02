import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Presentational `.mcp.json` renderer for the connect-agents hand-off. Assembles
 * the `project-management` MCP server config (pool-secret form by default, with a
 * token form alternative) and offers copy-to-clipboard.
 *
 * The `args` path is the consumer's DEPLOYED bundle path, which this component
 * cannot know — it emits a clear placeholder the user must replace with their
 * actual bundle path (see docs/SETUP.md).
 */

// The bundle path is deployment-specific; emit an obvious placeholder.
const BUNDLE_PATH_PLACEHOLDER = "/absolute/path/to/tools/pm-mcp-server/pm-mcp-server.mjs";

type McpConfigSnippetProps =
  | { poolName: string; poolSecret: string; apiUrl?: string }
  | { mode: "token"; apiToken: string; apiUrl?: string };

function buildConfig(props: McpConfigSnippetProps): Record<string, unknown> {
  const apiUrl = props.apiUrl ?? window.location.origin;
  const env =
    "mode" in props
      ? { PM_API_URL: apiUrl, PM_API_TOKEN: props.apiToken }
      : {
          PM_API_URL: apiUrl,
          PM_POOL_NAME: props.poolName,
          PM_POOL_SECRET: props.poolSecret,
        };
  return {
    mcpServers: {
      "project-management": {
        command: "node",
        args: [BUNDLE_PATH_PLACEHOLDER],
        env,
      },
    },
  };
}

export function McpConfigSnippet(props: McpConfigSnippetProps) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(buildConfig(props), null, 2);

  async function handleCopy() {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">.mcp.json</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopy}
          aria-label="Copy .mcp.json"
        >
          {copied ? (
            <>
              <Check className="size-4 text-green-600" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-4" />
              Copy
            </>
          )}
        </Button>
      </div>
      <pre className="bg-muted max-h-72 overflow-auto rounded-md border px-3 py-2">
        <code className="whitespace-pre break-all font-mono text-xs">{json}</code>
      </pre>
      <p className="text-muted-foreground text-xs">
        Replace <code className="font-mono">{BUNDLE_PATH_PLACEHOLDER}</code> with the actual path to
        your deployed MCP bundle — copy the MCP bundle into your project, see{" "}
        <code className="font-mono">docs/SETUP.md</code>.
      </p>
    </div>
  );
}
