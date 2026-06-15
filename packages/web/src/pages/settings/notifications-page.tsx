import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Bell, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject, useUpdateProject } from "@/hooks/use-projects";
import { ApiError, type UpdateProject } from "@/lib/api";
import { useProjectStore } from "@/stores/project-store";

// The project `settings` blob is typed as `unknown` on the Project response
// (the server stores it as opaque JSON). We only touch the `webhooks` sub-block
// here and preserve everything else verbatim — the PATCH replaces `settings`
// wholesale, so the existing object must be spread back in untouched.
interface WebhooksSettings {
  discord_url?: string;
  alerts_enabled?: boolean;
}

export function NotificationsPage() {
  const params = useParams({ strict: false });
  const { currentProjectId } = useProjectStore();
  const projectId =
    (params as Record<string, string | undefined>).projectId ?? currentProjectId ?? undefined;

  const { data: project, isLoading, error, refetch } = useProject(projectId);
  const updateMutation = useUpdateProject();

  const [discordUrl, setDiscordUrl] = useState("");
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Hydrate the form once the project loads (and whenever a different project
  // is selected).
  useEffect(() => {
    if (!project) return;
    const settings = (project.settings ?? {}) as { webhooks?: WebhooksSettings };
    const webhooks = settings.webhooks ?? {};
    setDiscordUrl(webhooks.discord_url ?? "");
    // alerts_enabled defaults to "on" when omitted (matches the server).
    setAlertsEnabled(webhooks.alerts_enabled !== false);
    setUrlError(null);
    setSaved(false);
  }, [project]);

  async function handleSave() {
    if (!projectId || !project) return;

    const trimmed = discordUrl.trim();
    if (trimmed) {
      try {
        // Mirror the server's z.string().url() gate to surface a friendly error
        // before the PATCH round-trips.
        new URL(trimmed);
      } catch {
        setUrlError("Enter a valid URL (e.g. https://discord.com/api/webhooks/...).");
        return;
      }
    }
    setUrlError(null);

    const webhooks: WebhooksSettings = { alerts_enabled: alertsEnabled };
    if (trimmed) webhooks.discord_url = trimmed;

    // Replace-wholesale: spread the existing settings so we don't drop
    // ai_autonomy / workflow / git / integrator.
    const existing = (project.settings ?? {}) as Record<string, unknown>;
    const settings = { ...existing, webhooks };

    try {
      await updateMutation.mutateAsync({
        id: projectId,
        // settings is opaque JSON on the wire; the generated UpdateProject type
        // wants the fully-structured object, but we're round-tripping the
        // server's own settings untouched, so a cast is safe here.
        data: { settings } as UpdateProject,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      // Error surfaced via updateMutation.isError below.
    }
  }

  if (!projectId) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Bell className="text-muted-foreground size-6" />
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Bell className="text-muted-foreground/50 mb-4 size-12" />
            <h3 className="text-lg font-medium">No Project Selected</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Select a project to configure notifications.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Bell className="text-muted-foreground size-6" />
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-destructive text-sm">
              Failed to load project settings. Please try again.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-6 w-48" />
          </CardContent>
        </Card>
      )}

      {/* Form */}
      {!isLoading && !error && project && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <svg
                className="size-4 text-[#5865F2]"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3.2a.074.074 0 0 0-.079.037c-.34.6-.715 1.386-.978 2.002a18.27 18.27 0 0 0-5.002 0 12.6 12.6 0 0 0-.992-2.002.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 5.67 4.369a.07.07 0 0 0-.032.027C3.04 8.236 2.34 11.99 2.685 15.7a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127c-.598.349-1.22.645-1.873.892a.076.076 0 0 0-.04.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-4.319-.838-8.042-3.549-11.304a.061.061 0 0 0-.031-.028ZM8.02 13.442c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.956 2.419-2.157 2.419Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.946 2.419-2.157 2.419Z" />
              </svg>
              Discord webhook
            </CardTitle>
            <CardDescription>
              Merge-train alerts ( <code className="text-xs">train.stuck</code>,{" "}
              <code className="text-xs">train.abandon_rate_high</code>,{" "}
              <code className="text-xs">train.integrator_unhealthy</code>) are POSTed to this
              Discord webhook, in addition to the in-app banner. Leave the URL blank to receive
              in-app alerts only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="discord-url">Webhook URL</Label>
              <Input
                id="discord-url"
                type="url"
                placeholder="https://discord.com/api/webhooks/..."
                value={discordUrl}
                onChange={(e) => {
                  setDiscordUrl(e.target.value);
                  if (urlError) setUrlError(null);
                  if (saved) setSaved(false);
                }}
              />
              {urlError ? (
                <p className="text-destructive text-xs">{urlError}</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  In Discord: Server Settings → Integrations → Webhooks → New Webhook, pick a
                  channel, and copy the URL.
                </p>
              )}
            </div>

            <div className="flex items-center justify-between rounded-md border px-4 py-3">
              <div className="space-y-0.5">
                <Label htmlFor="alerts-enabled">Send alerts to Discord</Label>
                <p className="text-muted-foreground text-xs">
                  Turn off to silence the outbound POST without removing the URL.
                </p>
              </div>
              <Switch
                id="alerts-enabled"
                checked={alertsEnabled}
                onCheckedChange={(checked) => {
                  setAlertsEnabled(checked);
                  if (saved) setSaved(false);
                }}
              />
            </div>

            {updateMutation.isError && (
              <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
                {updateMutation.error instanceof ApiError
                  ? updateMutation.error.message
                  : "Failed to save notification settings. Please try again."}
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button onClick={handleSave} disabled={updateMutation.isPending}>
                {updateMutation.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
              {saved && (
                <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                  <Check className="size-4" />
                  Saved
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
