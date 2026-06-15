import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, Globe, Key, Terminal, Rocket, BookOpen } from "lucide-react";

export function HelpPage() {
  const serverUrl = window.location.origin;

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        "project-management": {
          command: "node",
          args: ["<path-to>/pm-mcp-server.mjs"],
          env: {
            PM_API_URL: serverUrl,
            PM_API_TOKEN: "<your-ai-agent-api-token>",
          },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Getting Started</h1>
        <p className="text-muted-foreground mt-1">Set up AI agents and learn the workflow</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5" />
            Quick Start Guide
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <Step n={1} title="Create a project">
              Go to <strong>Projects</strong> and create your first project.
            </Step>
            <Step n={2} title="Write a proposal">
              Navigate to <strong>Proposals</strong> within your project. Describe what you want to
              build — be as vague or detailed as you like. This is your &ldquo;hand-wave&rdquo; to
              the AI.
            </Step>
            <Step n={3} title="AI discusses your proposal">
              Once an AI agent is connected (see below), it will pick up your proposal and start a
              design discussion in the comments.
            </Step>
            <Step n={4} title="Accept the design">
              When you're happy with the AI's design, click <strong>Accept</strong>. The AI will
              then create epics and tasks.
            </Step>
            <Step n={5} title="AI executes">
              The AI picks up tasks from the ready queue, implements them, and reports progress. You
              monitor via the <strong>Dashboard</strong>, <strong>Board</strong>, and{" "}
              <strong>Activity</strong> feed.
            </Step>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Connect an AI Agent (MCP)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <Step n={1} title="Create an AI agent user">
              Go to <strong>Settings &rarr; Users</strong> and click <strong>Add User</strong>. Set
              the type to <Badge variant="outline">AI Agent</Badge>. Copy the API token shown after
              creation — it&apos;s only displayed once.
            </Step>
            <Step n={2} title="Configure MCP in Claude">
              Add this to your Claude MCP settings (
              <code className="bg-muted rounded px-1 text-sm">.claude/settings.json</code> or{" "}
              <code className="bg-muted rounded px-1 text-sm">claude_desktop_config.json</code>
              ):
            </Step>
          </div>

          <pre className="bg-muted overflow-x-auto rounded-lg p-4 text-sm">
            <code>{mcpConfig}</code>
          </pre>

          <div className="space-y-3">
            <Step n={3} title="Replace the placeholders">
              <ul className="text-muted-foreground mt-1 list-inside list-disc space-y-1 text-sm">
                <li>
                  <code className="bg-muted rounded px-1">&lt;path-to&gt;/pm-mcp-server.mjs</code> —
                  the standalone MCP client file (365 KB, zero dependencies). Find it at{" "}
                  <code className="bg-muted rounded px-1">
                    packages/mcp-server/dist/bundle/pm-mcp-server.mjs
                  </code>{" "}
                  after building, then copy it wherever you like
                </li>
                <li>
                  <code className="bg-muted rounded px-1">&lt;your-ai-agent-api-token&gt;</code> —
                  the token from step 1
                </li>
                <li>
                  <code className="bg-muted rounded px-1">PM_API_URL</code> — already set to this
                  server&apos;s address. Change it if the server moves (e.g., to a Raspberry Pi at{" "}
                  <code className="bg-muted rounded px-1">http://192.168.1.x:3000</code>)
                </li>
              </ul>
            </Step>
            <Step n={4} title="Restart Claude">
              Claude will pick up the new MCP server on restart. You can verify by asking Claude to
              run <code className="bg-muted rounded px-1 text-sm">pm_list_projects</code>.
            </Step>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Available MCP Tools
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <ToolGroup title="Read">
              <Tool name="pm_list_projects" desc="List projects" />
              <Tool name="pm_list_proposals" desc="List proposals" />
              <Tool name="pm_get_proposal" desc="Get proposal with discussion" />
              <Tool name="pm_list_tasks" desc="List tasks with filters" />
              <Tool name="pm_get_task" desc="Full task details" />
              <Tool name="pm_search" desc="Full-text search" />
              <Tool name="pm_check_updates" desc="Poll for human activity" />
              <Tool name="pm_list_templates" desc="List templates" />
            </ToolGroup>
            <ToolGroup title="Write">
              <Tool name="pm_discuss_proposal" desc="Comment on proposal" />
              <Tool name="pm_implement_proposal" desc="Create work items" />
              <Tool name="pm_pick_next_task" desc="Claim next ready task" />
              <Tool name="pm_start_task" desc="Begin working on task" />
              <Tool name="pm_complete_task" desc="Mark done with handoff" />
              <Tool name="pm_request_review" desc="Submit for review" />
              <Tool name="pm_block_task" desc="Mark task as blocked" />
              <Tool name="pm_create_task" desc="Create a new task" />
              <Tool name="pm_update_task" desc="Update task fields" />
              <Tool name="pm_add_comment" desc="Add typed comment" />
              <Tool name="pm_log_decision" desc="Record design decision" />
              <Tool name="pm_report_progress" desc="Post progress update" />
              <Tool name="pm_set_task_context" desc="Set AI context" />
              <Tool name="pm_link_git_ref" desc="Link branch/commit/PR" />
              <Tool name="pm_use_template" desc="Instantiate template" />
            </ToolGroup>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Useful Links
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <LinkItem
              href={`${serverUrl}/api/v1/docs`}
              title="API Documentation"
              desc="Interactive OpenAPI docs (Scalar)"
            />
            <LinkItem
              href={`${serverUrl}/api/v1/openapi.json`}
              title="OpenAPI Spec"
              desc="Machine-readable API specification"
            />
            <LinkItem
              href={`${serverUrl}/health`}
              title="Health Check"
              desc="Server status endpoint"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Keyboard Shortcuts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Shortcut keys="Ctrl+K" desc="Open command palette (search)" />
            <Shortcut keys="?" desc="Show keyboard shortcuts overlay" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="bg-primary text-primary-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
        {n}
      </div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{children}</p>
      </div>
    </div>
  );
}

function ToolGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Tool({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <code className="bg-muted shrink-0 rounded px-1 text-xs">{name}</code>
      <span className="text-muted-foreground">{desc}</span>
    </div>
  );
}

function LinkItem({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:bg-muted flex items-center justify-between rounded-lg p-2 transition-colors"
    >
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{desc}</p>
      </div>
      <BookOpen className="text-muted-foreground h-4 w-4" />
    </a>
  );
}

function Shortcut({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{desc}</span>
      <kbd className="bg-muted rounded border px-2 py-0.5 font-mono text-xs">{keys}</kbd>
    </div>
  );
}
