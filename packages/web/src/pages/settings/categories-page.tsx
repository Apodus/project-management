import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Loader2,
  Plus,
  Tags,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject, useUpdateProject } from "@/hooks/use-projects";
import { ApiError, type UpdateProject } from "@/lib/api";
import {
  epicCategoriesFromProject,
  type EpicCategory,
} from "@/lib/epic-categories";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";

// Suggested swatch palette (Tailwind-derived hexes). Clicking one sets the
// row's color; the native color input still allows any custom value.
const SUGGESTED_COLORS = [
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#f59e0b",
  "#f43f5e",
  "#06b6d4",
  "#f97316",
  "#ec4899",
  "#14b8a6",
  "#6366f1",
] as const;

export function CategoriesPage() {
  const params = useParams({ strict: false });
  const { currentProjectId } = useProjectStore();
  const projectId =
    (params as Record<string, string | undefined>).projectId ??
    currentProjectId ??
    undefined;

  const { data: project, isLoading, error, refetch } = useProject(projectId);
  const updateMutation = useUpdateProject();

  const [categories, setCategories] = useState<EpicCategory[]>([]);
  const [saved, setSaved] = useState(false);

  // Hydrate the editor once the project loads (and whenever a different project
  // is selected). The helper returns a sort_order-ordered copy.
  useEffect(() => {
    if (!project) return;
    setCategories(epicCategoriesFromProject(project));
    setSaved(false);
  }, [project]);

  function patchRow(index: number, patch: Partial<EpicCategory>) {
    setCategories((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
    if (saved) setSaved(false);
  }

  function addCategory() {
    setCategories((prev) => [
      ...prev,
      { name: "", color: "#3b82f6", sort_order: prev.length },
    ]);
    if (saved) setSaved(false);
  }

  function removeCategory(index: number) {
    setCategories((prev) => prev.filter((_, i) => i !== index));
    if (saved) setSaved(false);
  }

  function move(index: number, dir: -1 | 1) {
    setCategories((prev) => {
      const next = prev.slice();
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    if (saved) setSaved(false);
  }

  // Validation: every name must be non-blank and unique (by trimmed name).
  const trimmedNames = categories.map((c) => c.name.trim());
  const hasBlank = trimmedNames.some((n) => n === "");
  const hasDuplicate =
    new Set(trimmedNames.map((n) => n.toLowerCase())).size !==
    trimmedNames.length;
  const canSave = !hasBlank && !hasDuplicate;

  async function handleSave() {
    if (!projectId || !project || !canSave) return;

    // Reindex sort_order to the current row order on save.
    const epic_categories = categories.map((c, i) => ({
      name: c.name.trim(),
      color: c.color,
      sort_order: i,
    }));

    // Replace-wholesale: spread the existing settings so we don't drop
    // integrator / webhooks / ai_autonomy / workflow / git.
    const existing = (project.settings ?? {}) as Record<string, unknown>;
    const settings = { ...existing, epic_categories };

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
          <Tags className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Categories</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Tags className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium">No Project Selected</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Select a project to configure epic categories.
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
        <Tags className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Categories</h1>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-destructive">
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
            <Skeleton className="h-9 w-full" />
          </CardContent>
        </Card>
      )}

      {/* Form */}
      {!isLoading && !error && project && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Tags className="size-4 text-muted-foreground" />
              Epic categories
            </CardTitle>
            <CardDescription>
              Define a palette of categories to group and color-code epics.
              Categories are assigned per-epic from the epic detail page. Order
              here controls how they appear in the assign menu.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {categories.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-10">
                <Tags className="mb-2 size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No categories yet. Add one to get started.
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {categories.map((category, index) => {
                  const trimmed = category.name.trim();
                  const isDuplicate =
                    trimmed !== "" &&
                    trimmedNames.filter(
                      (n) => n.toLowerCase() === trimmed.toLowerCase(),
                    ).length > 1;
                  return (
                    <li
                      key={index}
                      className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-3"
                    >
                      {/* Color picker */}
                      <input
                        type="color"
                        aria-label={`Color for category ${index + 1}`}
                        value={category.color}
                        onChange={(e) =>
                          patchRow(index, { color: e.target.value })
                        }
                        className="size-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                      />

                      {/* Name */}
                      <div className="min-w-[160px] flex-1 space-y-1">
                        <Input
                          aria-label={`Name for category ${index + 1}`}
                          placeholder="Category name"
                          value={category.name}
                          onChange={(e) =>
                            patchRow(index, { name: e.target.value })
                          }
                          className={cn(
                            isDuplicate && "border-destructive",
                          )}
                        />
                        {isDuplicate && (
                          <p className="text-xs text-destructive">
                            Duplicate name.
                          </p>
                        )}
                      </div>

                      {/* Suggested swatches */}
                      <div className="flex items-center gap-1">
                        {SUGGESTED_COLORS.map((hex) => (
                          <button
                            key={hex}
                            type="button"
                            aria-label={`Set color ${hex}`}
                            title={hex}
                            onClick={() => patchRow(index, { color: hex })}
                            className={cn(
                              "size-5 rounded-full border transition-transform hover:scale-110",
                              category.color.toLowerCase() === hex &&
                                "ring-2 ring-ring ring-offset-1 ring-offset-background",
                            )}
                            style={{ backgroundColor: hex }}
                          />
                        ))}
                      </div>

                      {/* Reorder + remove */}
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Move up"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Move down"
                          disabled={index === categories.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove category"
                          onClick={() => removeCategory(index)}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <Button variant="outline" size="sm" onClick={addCategory}>
              <Plus className="size-4" />
              Add category
            </Button>

            {updateMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {updateMutation.error instanceof ApiError
                  ? updateMutation.error.message
                  : "Failed to save categories. Please try again."}
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                onClick={handleSave}
                disabled={updateMutation.isPending || !canSave}
              >
                {updateMutation.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
              {hasBlank && (
                <span className="text-sm text-muted-foreground">
                  Every category needs a name.
                </span>
              )}
              {!hasBlank && hasDuplicate && (
                <span className="text-sm text-muted-foreground">
                  Category names must be unique.
                </span>
              )}
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
