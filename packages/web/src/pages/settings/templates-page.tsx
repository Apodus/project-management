import { useState } from "react";
import {
  Copy,
  FileText,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  useTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
  useInstantiateTemplate,
} from "@/hooks/use-templates";
import { useProjects } from "@/hooks/use-projects";
import {
  ApiError,
  type Template,
  type CreateTemplateData,
  type UpdateTemplateData,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsNav } from "@/components/settings-nav";

// ---- Constants ----

const TASK_TYPES = [
  "feature",
  "bug",
  "chore",
  "spike",
  "design",
  "research",
] as const;

const PRIORITIES = ["critical", "high", "medium", "low"] as const;

const EFFORTS = ["xs", "s", "m", "l", "xl"] as const;

const EFFORT_LABELS: Record<string, string> = {
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

// ---- Types ----

interface SubtaskDraft {
  title: string;
  type: string;
  effort: string;
}

interface EpicDraft {
  name: string;
  tasks: { title: string; type: string }[];
}

interface LabelDraft {
  name: string;
  color: string;
}

// ---- Subtask List Editor ----

function SubtaskListEditor({
  subtasks,
  onChange,
}: {
  subtasks: SubtaskDraft[];
  onChange: (subtasks: SubtaskDraft[]) => void;
}) {
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("feature");
  const [newEffort, setNewEffort] = useState("m");

  function addSubtask() {
    if (!newTitle.trim()) return;
    onChange([
      ...subtasks,
      { title: newTitle.trim(), type: newType, effort: newEffort },
    ]);
    setNewTitle("");
  }

  function removeSubtask(index: number) {
    onChange(subtasks.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      <Label>Subtasks</Label>
      {subtasks.length > 0 && (
        <div className="space-y-1.5">
          {subtasks.map((sub, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
            >
              <span className="flex-1 truncate">{sub.title}</span>
              <Badge variant="secondary" className="text-[10px]">
                {sub.type}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {EFFORT_LABELS[sub.effort] ?? sub.effort}
              </Badge>
              <button
                type="button"
                onClick={() => removeSubtask(i)}
                className="rounded p-0.5 hover:bg-muted"
              >
                <X className="size-3 text-muted-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            placeholder="Subtask title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSubtask();
              }
            }}
            className="h-8 text-sm"
          />
        </div>
        <Select value={newType} onValueChange={setNewType}>
          <SelectTrigger className="h-8 w-[100px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TASK_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={newEffort} onValueChange={setNewEffort}>
          <SelectTrigger className="h-8 w-[70px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EFFORTS.map((e) => (
              <SelectItem key={e} value={e}>
                {EFFORT_LABELS[e]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addSubtask}
          disabled={!newTitle.trim()}
          className="h-8"
        >
          <Plus className="size-3" />
        </Button>
      </div>
    </div>
  );
}

// ---- Epic List Editor ----

function EpicListEditor({
  epics,
  onChange,
}: {
  epics: EpicDraft[];
  onChange: (epics: EpicDraft[]) => void;
}) {
  const [newEpicName, setNewEpicName] = useState("");

  function addEpic() {
    if (!newEpicName.trim()) return;
    onChange([...epics, { name: newEpicName.trim(), tasks: [] }]);
    setNewEpicName("");
  }

  function removeEpic(index: number) {
    onChange(epics.filter((_, i) => i !== index));
  }

  function addTaskToEpic(epicIndex: number, title: string, type: string) {
    const updated = epics.map((epic, i) =>
      i === epicIndex
        ? { ...epic, tasks: [...epic.tasks, { title, type }] }
        : epic,
    );
    onChange(updated);
  }

  function removeTaskFromEpic(epicIndex: number, taskIndex: number) {
    const updated = epics.map((epic, i) =>
      i === epicIndex
        ? { ...epic, tasks: epic.tasks.filter((_, j) => j !== taskIndex) }
        : epic,
    );
    onChange(updated);
  }

  return (
    <div className="space-y-3">
      <Label>Epics</Label>
      {epics.map((epic, ei) => (
        <div key={ei} className="rounded-md border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{epic.name}</span>
            <button
              type="button"
              onClick={() => removeEpic(ei)}
              className="rounded p-0.5 hover:bg-muted"
            >
              <X className="size-3 text-muted-foreground" />
            </button>
          </div>
          {epic.tasks.length > 0 && (
            <div className="ml-4 space-y-1">
              {epic.tasks.map((task, ti) => (
                <div
                  key={ti}
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <FileText className="size-3" />
                  <span className="flex-1 truncate">{task.title}</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {task.type}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => removeTaskFromEpic(ei, ti)}
                    className="rounded p-0.5 hover:bg-muted"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <EpicTaskAdder
            onAdd={(title, type) => addTaskToEpic(ei, title, type)}
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Epic name"
          value={newEpicName}
          onChange={(e) => setNewEpicName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addEpic();
            }
          }}
          className="h-8 text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addEpic}
          disabled={!newEpicName.trim()}
          className="h-8"
        >
          <Plus className="size-3" />
          Add Epic
        </Button>
      </div>
    </div>
  );
}

function EpicTaskAdder({
  onAdd,
}: {
  onAdd: (title: string, type: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("feature");

  function handleAdd() {
    if (!title.trim()) return;
    onAdd(title.trim(), type);
    setTitle("");
  }

  return (
    <div className="ml-4 flex items-center gap-2">
      <Input
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleAdd();
          }
        }}
        className="h-7 text-xs"
      />
      <Select value={type} onValueChange={setType}>
        <SelectTrigger className="h-7 w-[90px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TASK_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={handleAdd}
        disabled={!title.trim()}
        className="h-7 px-2"
      >
        <Plus className="size-3" />
      </Button>
    </div>
  );
}

// ---- Label List Editor ----

function LabelListEditor({
  labels,
  onChange,
}: {
  labels: LabelDraft[];
  onChange: (labels: LabelDraft[]) => void;
}) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#3b82f6");

  function addLabel() {
    if (!newName.trim()) return;
    onChange([...labels, { name: newName.trim(), color: newColor }]);
    setNewName("");
  }

  function removeLabel(index: number) {
    onChange(labels.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      <Label>Labels</Label>
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {labels.map((label, i) => (
            <Badge
              key={i}
              variant="outline"
              className="flex items-center gap-1 pr-1"
            >
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: label.color }}
              />
              {label.name}
              <button
                type="button"
                onClick={() => removeLabel(i)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Label name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addLabel();
            }
          }}
          className="h-8 text-sm"
        />
        <input
          type="color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded border"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addLabel}
          disabled={!newName.trim()}
          className="h-8"
        >
          <Plus className="size-3" />
        </Button>
      </div>
    </div>
  );
}

// ---- Create/Edit Template Dialog ----

function TemplateFormDialog({
  open,
  onOpenChange,
  editTemplate,
  defaultType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTemplate?: Template | null;
  defaultType?: "task" | "project";
}) {
  const createMutation = useCreateTemplate();
  const updateMutation = useUpdateTemplate();
  const isEditing = !!editTemplate;

  const existingData = (editTemplate?.templateData ?? {}) as Record<
    string,
    unknown
  >;

  const [name, setName] = useState(editTemplate?.name ?? "");
  const [description, setDescription] = useState(
    editTemplate?.description ?? "",
  );
  const [templateType, setTemplateType] = useState<"task" | "project">(
    (editTemplate?.templateType as "task" | "project") ?? defaultType ?? "task",
  );

  // Task template fields
  const [titlePrefix, setTitlePrefix] = useState(
    (existingData.title_prefix as string) ?? "",
  );
  const [taskType, setTaskType] = useState(
    (existingData.type as string) ?? "feature",
  );
  const [priority, setPriority] = useState(
    (existingData.priority as string) ?? "medium",
  );
  const [effort, setEffort] = useState(
    (existingData.estimated_effort as string) ?? "m",
  );
  const [taskDescription, setTaskDescription] = useState(
    (existingData.description as string) ?? "",
  );
  const [subtasks, setSubtasks] = useState<SubtaskDraft[]>(
    (existingData.subtasks as SubtaskDraft[]) ?? [],
  );

  // Project template fields
  const [projectDescription, setProjectDescription] = useState(
    (existingData.description as string) ?? "",
  );
  const [epics, setEpics] = useState<EpicDraft[]>(
    (existingData.epics as EpicDraft[]) ?? [],
  );
  const [labels, setLabels] = useState<LabelDraft[]>(
    (existingData.labels as LabelDraft[]) ?? [],
  );

  const [errors, setErrors] = useState<Record<string, string>>({});

  function resetForm() {
    setName("");
    setDescription("");
    setTemplateType(defaultType ?? "task");
    setTitlePrefix("");
    setTaskType("feature");
    setPriority("medium");
    setEffort("m");
    setTaskDescription("");
    setSubtasks([]);
    setProjectDescription("");
    setEpics([]);
    setLabels([]);
    setErrors({});
    createMutation.reset();
    updateMutation.reset();
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = "Name is required";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function buildTemplateData(): Record<string, unknown> {
    if (templateType === "task") {
      const data: Record<string, unknown> = {};
      if (titlePrefix.trim()) data.title_prefix = titlePrefix.trim();
      if (taskDescription.trim()) data.description = taskDescription.trim();
      data.type = taskType;
      data.priority = priority;
      data.estimated_effort = effort;
      if (subtasks.length > 0) data.subtasks = subtasks;
      return data;
    }
    // project
    const data: Record<string, unknown> = {};
    if (projectDescription.trim())
      data.description = projectDescription.trim();
    if (epics.length > 0) data.epics = epics;
    if (labels.length > 0) data.labels = labels;
    return data;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const templateData = buildTemplateData();

    try {
      if (isEditing && editTemplate) {
        const updateData: UpdateTemplateData = {
          name: name.trim(),
          description: description.trim() || null,
          template_data: templateData,
        };
        await updateMutation.mutateAsync({
          id: editTemplate.id,
          data: updateData,
        });
      } else {
        const createData: CreateTemplateData = {
          name: name.trim(),
          description: description.trim() || null,
          template_type: templateType,
          template_data: templateData,
        };
        await createMutation.mutateAsync(createData);
      }
      onOpenChange(false);
      resetForm();
    } catch {
      // Error handled by mutation state
    }
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  }

  const mutation = isEditing ? updateMutation : createMutation;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEditing ? "Edit Template" : "New Template"}
            </DialogTitle>
            <DialogDescription>
              {isEditing
                ? "Update the template configuration."
                : "Create a reusable template for tasks or projects."}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                placeholder="e.g. Bug Report Template"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (errors.name) setErrors((p) => ({ ...p, name: "" }));
                }}
                autoFocus
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name}</p>
              )}
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="tpl-desc">Description</Label>
              <Textarea
                id="tpl-desc"
                placeholder="What is this template for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            {/* Template type (only when creating) */}
            {!isEditing && (
              <div className="space-y-2">
                <Label htmlFor="tpl-type">Type</Label>
                <Select
                  value={templateType}
                  onValueChange={(v) =>
                    setTemplateType(v as "task" | "project")
                  }
                >
                  <SelectTrigger id="tpl-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="task">Task Template</SelectItem>
                    <SelectItem value="project">Project Template</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Task template fields */}
            {templateType === "task" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="tpl-title-prefix">Title Prefix</Label>
                  <Input
                    id="tpl-title-prefix"
                    placeholder="e.g. Bug Fix: "
                    value={titlePrefix}
                    onChange={(e) => setTitlePrefix(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-2">
                    <Label>Task Type</Label>
                    <Select value={taskType} onValueChange={setTaskType}>
                      <SelectTrigger className="w-full text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TASK_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Priority</Label>
                    <Select value={priority} onValueChange={setPriority}>
                      <SelectTrigger className="w-full text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PRIORITIES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Effort</Label>
                    <Select value={effort} onValueChange={setEffort}>
                      <SelectTrigger className="w-full text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EFFORTS.map((e) => (
                          <SelectItem key={e} value={e}>
                            {EFFORT_LABELS[e]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tpl-task-desc">Task Description</Label>
                  <Textarea
                    id="tpl-task-desc"
                    placeholder="Markdown description template..."
                    value={taskDescription}
                    onChange={(e) => setTaskDescription(e.target.value)}
                    rows={4}
                    className="font-mono text-sm"
                  />
                </div>
                <SubtaskListEditor
                  subtasks={subtasks}
                  onChange={setSubtasks}
                />
              </>
            )}

            {/* Project template fields */}
            {templateType === "project" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="tpl-proj-desc">Project Description</Label>
                  <Textarea
                    id="tpl-proj-desc"
                    placeholder="Description for projects created from this template..."
                    value={projectDescription}
                    onChange={(e) => setProjectDescription(e.target.value)}
                    rows={3}
                  />
                </div>
                <EpicListEditor epics={epics} onChange={setEpics} />
                <LabelListEditor labels={labels} onChange={setLabels} />
              </>
            )}

            {mutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {mutation.error instanceof ApiError
                  ? mutation.error.message
                  : `Failed to ${isEditing ? "update" : "create"} template.`}
              </div>
            )}
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {isEditing ? "Saving..." : "Creating..."}
                </>
              ) : isEditing ? (
                "Save Changes"
              ) : (
                "Create Template"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Use Template Dialog ----

function UseTemplateDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: Template;
}) {
  const instantiateMutation = useInstantiateTemplate();
  const { data: projects } = useProjects();

  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function resetForm() {
    setProjectId("");
    setProjectName("");
    setErrors({});
    instantiateMutation.reset();
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (template.templateType === "task" && !projectId) {
      newErrors.projectId = "Please select a project";
    }
    if (template.templateType === "project" && !projectName.trim()) {
      newErrors.projectName = "Project name is required";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    try {
      if (template.templateType === "task") {
        await instantiateMutation.mutateAsync({
          id: template.id,
          data: { project_id: projectId },
        });
      } else {
        await instantiateMutation.mutateAsync({
          id: template.id,
          data: {
            workspace_id: "default",
            name: projectName.trim(),
          },
        });
      }
      onOpenChange(false);
      resetForm();
    } catch {
      // Error handled by mutation state
    }
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Use Template: {template.name}</DialogTitle>
            <DialogDescription>
              {template.templateType === "task"
                ? "Create a new task from this template. Select the target project."
                : "Create a new project from this template."}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            {template.templateType === "task" && (
              <div className="space-y-2">
                <Label htmlFor="use-project">Target Project</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="use-project" className="w-full">
                    <SelectValue placeholder="Select a project..." />
                  </SelectTrigger>
                  <SelectContent>
                    {projects?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.projectId && (
                  <p className="text-xs text-destructive">
                    {errors.projectId}
                  </p>
                )}
              </div>
            )}

            {template.templateType === "project" && (
              <div className="space-y-2">
                <Label htmlFor="use-name">Project Name</Label>
                <Input
                  id="use-name"
                  placeholder="My New Project"
                  value={projectName}
                  onChange={(e) => {
                    setProjectName(e.target.value);
                    if (errors.projectName)
                      setErrors((p) => ({ ...p, projectName: "" }));
                  }}
                  autoFocus
                />
                {errors.projectName && (
                  <p className="text-xs text-destructive">
                    {errors.projectName}
                  </p>
                )}
              </div>
            )}

            {instantiateMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {instantiateMutation.error instanceof ApiError
                  ? instantiateMutation.error.message
                  : "Failed to instantiate template."}
              </div>
            )}

            {instantiateMutation.isSuccess && (
              <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
                Template instantiated successfully!
              </div>
            )}
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={instantiateMutation.isPending}>
              {instantiateMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Play className="size-4" />
                  {template.templateType === "task"
                    ? "Create Task"
                    : "Create Project"}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Delete Confirmation Dialog ----

function DeleteTemplateDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: Template;
}) {
  const deleteMutation = useDeleteTemplate();

  async function handleDelete() {
    try {
      await deleteMutation.mutateAsync(template.id);
      onOpenChange(false);
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Template</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete "{template.name}"? This action
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {deleteMutation.isError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {deleteMutation.error instanceof ApiError
              ? deleteMutation.error.message
              : "Failed to delete template."}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete Template"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Template Card ----

function TemplateCard({ template }: { template: Template }) {
  const [editOpen, setEditOpen] = useState(false);
  const [useOpen, setUseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const data = (template.templateData ?? {}) as Record<string, unknown>;
  const subtaskCount =
    template.templateType === "task" && Array.isArray(data.subtasks)
      ? data.subtasks.length
      : 0;
  const epicCount =
    template.templateType === "project" && Array.isArray(data.epics)
      ? data.epics.length
      : 0;

  return (
    <>
      <Card className="transition-shadow hover:shadow-md">
        <CardContent className="flex items-start justify-between gap-3 p-4">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              {template.templateType === "task" ? (
                <FileText className="size-4 shrink-0 text-blue-500" />
              ) : (
                <FolderOpen className="size-4 shrink-0 text-purple-500" />
              )}
              <h3 className="truncate text-sm font-medium">
                {template.name}
              </h3>
            </div>
            {template.description && (
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {template.description}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Badge
                variant="secondary"
                className={cn(
                  "text-[10px]",
                  template.templateType === "task"
                    ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400"
                    : "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400",
                )}
              >
                {template.templateType === "task" ? "Task" : "Project"}
              </Badge>
              {subtaskCount > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  {subtaskCount} subtask{subtaskCount !== 1 ? "s" : ""}
                </span>
              )}
              {epicCount > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  {epicCount} epic{epicCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUseOpen(true)}
              className="h-7 gap-1 text-xs"
            >
              <Play className="size-3" />
              Use
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm">
                  <MoreHorizontal className="size-4" />
                  <span className="sr-only">
                    Actions for {template.name}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setEditOpen(true)}>
                  <Pencil className="mr-2 size-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setDeleteOpen(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardContent>
      </Card>

      <TemplateFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        editTemplate={template}
      />
      <UseTemplateDialog
        open={useOpen}
        onOpenChange={setUseOpen}
        template={template}
      />
      <DeleteTemplateDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        template={template}
      />
    </>
  );
}

// ---- Empty State ----

function EmptyState({
  type,
  onCreateClick,
}: {
  type: "task" | "project";
  onCreateClick: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      {type === "task" ? (
        <FileText className="mb-4 size-12 text-muted-foreground/50" />
      ) : (
        <FolderOpen className="mb-4 size-12 text-muted-foreground/50" />
      )}
      <h3 className="text-lg font-medium">
        No {type} templates
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Create a template to speed up repetitive work.
      </p>
      <Button className="mt-4" size="sm" onClick={onCreateClick}>
        <Plus className="size-4" />
        New {type === "task" ? "Task" : "Project"} Template
      </Button>
    </div>
  );
}

// ---- Main Page ----

export function TemplatesPage() {
  const { data: templates, isLoading, error, refetch } = useTemplates();
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<"task" | "project">("task");

  const taskTemplates =
    templates?.filter((t) => t.templateType === "task") ?? [];
  const projectTemplates =
    templates?.filter((t) => t.templateType === "project") ?? [];

  function handleCreateForType(type: "task" | "project") {
    setCreateType(type);
    setCreateOpen(true);
  }

  return (
    <div className="space-y-6">
      <SettingsNav />

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Copy className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Templates</h1>
        </div>
        <Button size="sm" onClick={() => handleCreateForType("task")}>
          <Plus className="size-4" />
          New Template
        </Button>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-destructive">
              Failed to load templates. Please try again.
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
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-4 w-4" />
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-5 w-16" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Templates tabs */}
      {!isLoading && !error && templates && (
        <Tabs defaultValue="task">
          <TabsList>
            <TabsTrigger value="task">
              Task Templates
              {taskTemplates.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-[10px]">
                  {taskTemplates.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="project">
              Project Templates
              {projectTemplates.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-[10px]">
                  {projectTemplates.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="task">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">
                      Task Templates
                    </CardTitle>
                    <CardDescription>
                      Reusable task configurations with subtasks and metadata.
                    </CardDescription>
                  </div>
                  {taskTemplates.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleCreateForType("task")}
                    >
                      <Plus className="size-4" />
                      New
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {taskTemplates.length === 0 ? (
                  <EmptyState
                    type="task"
                    onCreateClick={() => handleCreateForType("task")}
                  />
                ) : (
                  <div className="space-y-2">
                    {taskTemplates.map((template) => (
                      <TemplateCard key={template.id} template={template} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="project">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">
                      Project Templates
                    </CardTitle>
                    <CardDescription>
                      Full project scaffolds with epics, tasks, and labels.
                    </CardDescription>
                  </div>
                  {projectTemplates.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleCreateForType("project")}
                    >
                      <Plus className="size-4" />
                      New
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {projectTemplates.length === 0 ? (
                  <EmptyState
                    type="project"
                    onCreateClick={() => handleCreateForType("project")}
                  />
                ) : (
                  <div className="space-y-2">
                    {projectTemplates.map((template) => (
                      <TemplateCard key={template.id} template={template} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {/* Create Template Dialog */}
      <TemplateFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultType={createType}
      />
    </div>
  );
}
