import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import {
  Loader2,
  Plus,
  Trash2,
  Pencil,
  Zap,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  useAutomationRules,
  useCreateAutomationRule,
  useUpdateAutomationRule,
  useDeleteAutomationRule,
  useToggleAutomationRule,
} from "@/hooks/use-automation";
import {
  ApiError,
  type AutomationRule,
  type AutomationCondition,
  type CreateAutomationRuleData,
} from "@/lib/api";
import { useProjectStore } from "@/stores/project-store";

// ---- Constants ----

const TRIGGER_EVENTS = [
  { value: "task.created", label: "Task Created" },
  { value: "task.status_changed", label: "Task Status Changed" },
  { value: "task.assigned", label: "Task Assigned" },
  { value: "comment.created", label: "Comment Created" },
  { value: "epic.updated", label: "Epic Updated" },
  { value: "proposal.transitioned", label: "Proposal Transitioned" },
] as const;

const TRIGGER_EVENT_LABELS: Record<string, string> = {
  "task.created": "Task Created",
  "task.status_changed": "Task Status Changed",
  "task.assigned": "Task Assigned",
  "comment.created": "Comment Created",
  "epic.updated": "Epic Updated",
  "proposal.transitioned": "Proposal Transitioned",
};

const CONDITION_FIELDS_BY_TRIGGER: Record<string, { value: string; label: string }[]> = {
  "task.created": [
    { value: "priority", label: "Priority" },
    { value: "type", label: "Type" },
    { value: "status", label: "Status" },
  ],
  "task.status_changed": [
    { value: "changes.status.to", label: "New Status" },
    { value: "changes.status.from", label: "Old Status" },
    { value: "priority", label: "Priority" },
    { value: "type", label: "Type" },
  ],
  "task.assigned": [
    { value: "assigneeId", label: "Assignee" },
    { value: "priority", label: "Priority" },
    { value: "type", label: "Type" },
  ],
  "comment.created": [
    { value: "commentType", label: "Comment Type" },
  ],
  "epic.updated": [
    { value: "status", label: "Status" },
    { value: "changes.status.to", label: "New Status" },
    { value: "changes.status.from", label: "Old Status" },
  ],
  "proposal.transitioned": [
    { value: "changes.status.to", label: "New Status" },
    { value: "changes.status.from", label: "Old Status" },
  ],
};

const OPERATORS = [
  { value: "eq", label: "Equals" },
  { value: "neq", label: "Not Equals" },
  { value: "in", label: "In" },
  { value: "contains", label: "Contains" },
] as const;

const OPERATOR_LABELS: Record<string, string> = {
  eq: "equals",
  neq: "not equals",
  in: "in",
  not_in: "not in",
  contains: "contains",
};

const ACTION_TYPES = [
  { value: "transition_task", label: "Transition Task" },
  { value: "transition_epic", label: "Transition Epic" },
  { value: "create_comment", label: "Add Comment" },
  { value: "notify", label: "Notify (Activity Log)" },
] as const;

const ACTION_TYPE_LABELS: Record<string, string> = {
  transition_task: "Transition Task",
  transition_epic: "Transition Epic",
  create_comment: "Add Comment",
  notify: "Notify",
};

const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];
const EPIC_STATUSES = ["planned", "in_progress", "completed", "cancelled"];

// ---- Helpers ----

function summarizeConditions(conditions: AutomationCondition[] | null): string {
  if (!conditions || conditions.length === 0) return "No conditions";
  return conditions
    .map((c) => {
      const op = OPERATOR_LABELS[c.operator] ?? c.operator;
      const val = Array.isArray(c.value) ? c.value.join(", ") : String(c.value ?? "");
      return `${c.field} ${op} ${val}`;
    })
    .join(" AND ");
}

function summarizeAction(actionType: string, actionConfig: Record<string, unknown> | null): string {
  const label = ACTION_TYPE_LABELS[actionType] ?? actionType;
  if (!actionConfig) return label;
  if (actionType === "transition_task" || actionType === "transition_epic") {
    return `${label} -> ${actionConfig.to_status ?? "?"}`;
  }
  if (actionType === "create_comment") {
    const body = String(actionConfig.body ?? "");
    return `${label}: "${body.length > 40 ? body.slice(0, 40) + "..." : body}"`;
  }
  if (actionType === "notify") {
    return `${label}: ${actionConfig.message ?? ""}`;
  }
  return label;
}

function isBuiltIn(rule: AutomationRule): boolean {
  return rule.createdBy === null || rule.createdBy === "system";
}

// ---- Condition Row ----

function ConditionRow({
  condition,
  index,
  triggerEvent,
  onChange,
  onRemove,
}: {
  condition: AutomationCondition;
  index: number;
  triggerEvent: string;
  onChange: (index: number, condition: AutomationCondition) => void;
  onRemove: (index: number) => void;
}) {
  const fields = CONDITION_FIELDS_BY_TRIGGER[triggerEvent] ?? [];

  return (
    <div className="flex items-start gap-2">
      <div className="flex-1 grid grid-cols-3 gap-2">
        <Select
          value={condition.field}
          onValueChange={(v) => onChange(index, { ...condition, field: v })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Field" />
          </SelectTrigger>
          <SelectContent>
            {fields.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={condition.operator}
          onValueChange={(v) =>
            onChange(index, {
              ...condition,
              operator: v as AutomationCondition["operator"],
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Operator" />
          </SelectTrigger>
          <SelectContent>
            {OPERATORS.map((op) => (
              <SelectItem key={op.value} value={op.value}>
                {op.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          placeholder="Value"
          value={String(condition.value ?? "")}
          onChange={(e) =>
            onChange(index, { ...condition, value: e.target.value })
          }
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => onRemove(index)}
        aria-label="Remove condition"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

// ---- Action Config Form ----

function ActionConfigForm({
  actionType,
  actionConfig,
  onChange,
}: {
  actionType: string;
  actionConfig: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  if (actionType === "transition_task") {
    return (
      <div className="space-y-2">
        <Label>Target Status</Label>
        <Select
          value={String(actionConfig.to_status ?? "")}
          onValueChange={(v) => onChange({ ...actionConfig, to_status: v })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select status" />
          </SelectTrigger>
          <SelectContent>
            {TASK_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (actionType === "transition_epic") {
    return (
      <div className="space-y-2">
        <Label>Target Status</Label>
        <Select
          value={String(actionConfig.to_status ?? "")}
          onValueChange={(v) => onChange({ ...actionConfig, to_status: v })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select status" />
          </SelectTrigger>
          <SelectContent>
            {EPIC_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (actionType === "create_comment") {
    return (
      <div className="space-y-2">
        <Label>Comment Body</Label>
        <Textarea
          placeholder="Enter comment text..."
          value={String(actionConfig.body ?? "")}
          onChange={(e) => onChange({ ...actionConfig, body: e.target.value })}
          rows={3}
        />
      </div>
    );
  }

  if (actionType === "notify") {
    return (
      <div className="space-y-2">
        <Label>Message</Label>
        <Input
          placeholder="Notification message"
          value={String(actionConfig.message ?? "")}
          onChange={(e) =>
            onChange({ ...actionConfig, message: e.target.value })
          }
        />
      </div>
    );
  }

  return null;
}

// ---- Rule Dialog (Create + Edit) ----

function RuleDialog({
  open,
  onOpenChange,
  projectId,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  rule?: AutomationRule;
}) {
  const isEdit = !!rule;
  const createMutation = useCreateAutomationRule();
  const updateMutation = useUpdateAutomationRule();

  const [name, setName] = useState(rule?.name ?? "");
  const [triggerEvent, setTriggerEvent] = useState(
    rule?.triggerEvent ?? "",
  );
  const [conditions, setConditions] = useState<AutomationCondition[]>(
    (rule?.conditions as AutomationCondition[] | null) ?? [],
  );
  const [actionType, setActionType] = useState(rule?.actionType ?? "");
  const [actionConfig, setActionConfig] = useState<Record<string, unknown>>(
    (rule?.actionConfig as Record<string, unknown> | null) ?? {},
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const mutation = isEdit ? updateMutation : createMutation;

  function resetForm() {
    setName(rule?.name ?? "");
    setTriggerEvent(rule?.triggerEvent ?? "");
    setConditions(
      (rule?.conditions as AutomationCondition[] | null) ?? [],
    );
    setActionType(rule?.actionType ?? "");
    setActionConfig(
      (rule?.actionConfig as Record<string, unknown> | null) ?? {},
    );
    setErrors({});
    mutation.reset();
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = "Name is required";
    if (!triggerEvent) newErrors.triggerEvent = "Trigger event is required";
    if (!actionType) newErrors.actionType = "Action type is required";

    // Validate action config based on type
    if (actionType === "transition_task" || actionType === "transition_epic") {
      if (!actionConfig.to_status) {
        newErrors.actionConfig = "Target status is required";
      }
    }
    if (actionType === "create_comment") {
      if (!actionConfig.body || String(actionConfig.body).trim() === "") {
        newErrors.actionConfig = "Comment body is required";
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleConditionChange(
    index: number,
    condition: AutomationCondition,
  ) {
    setConditions((prev) => prev.map((c, i) => (i === index ? condition : c)));
  }

  function handleAddCondition() {
    setConditions((prev) => [
      ...prev,
      { field: "", operator: "eq", value: "" },
    ]);
  }

  function handleRemoveCondition(index: number) {
    setConditions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const data: CreateAutomationRuleData = {
      name: name.trim(),
      triggerEvent,
      conditions: conditions.length > 0 ? conditions : null,
      actionType,
      actionConfig: Object.keys(actionConfig).length > 0 ? actionConfig : null,
    };

    try {
      if (isEdit && rule) {
        await updateMutation.mutateAsync({ id: rule.id, data });
      } else {
        await createMutation.mutateAsync({ projectId, data });
      }
      onOpenChange(false);
      resetForm();
    } catch {
      // Error handled by mutation state
    }
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      resetForm();
    }
    onOpenChange(newOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEdit ? "Edit Rule" : "New Automation Rule"}
            </DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Update the automation rule configuration."
                : "Create a rule that triggers actions automatically based on events."}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="rule-name">Name</Label>
              <Input
                id="rule-name"
                placeholder="e.g., Auto-close epic when all tasks done"
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

            {/* Trigger Event */}
            <div className="space-y-2">
              <Label>Trigger Event</Label>
              <Select
                value={triggerEvent}
                onValueChange={(v) => {
                  setTriggerEvent(v);
                  // Reset conditions when trigger changes since fields depend on it
                  setConditions([]);
                  if (errors.triggerEvent)
                    setErrors((p) => ({ ...p, triggerEvent: "" }));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select trigger event" />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGER_EVENTS.map((te) => (
                    <SelectItem key={te.value} value={te.value}>
                      {te.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.triggerEvent && (
                <p className="text-xs text-destructive">
                  {errors.triggerEvent}
                </p>
              )}
            </div>

            {/* Conditions */}
            {triggerEvent && (
              <div className="space-y-2">
                <Label>Conditions</Label>
                <p className="text-xs text-muted-foreground">
                  All conditions must be met (AND logic).
                </p>
                <div className="space-y-2">
                  {conditions.map((condition, i) => (
                    <ConditionRow
                      key={i}
                      condition={condition}
                      index={i}
                      triggerEvent={triggerEvent}
                      onChange={handleConditionChange}
                      onRemove={handleRemoveCondition}
                    />
                  ))}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddCondition}
                >
                  <Plus className="size-3 mr-1" />
                  Add Condition
                </Button>
              </div>
            )}

            {/* Action Type */}
            <div className="space-y-2">
              <Label>Action Type</Label>
              <Select
                value={actionType}
                onValueChange={(v) => {
                  setActionType(v);
                  setActionConfig({});
                  if (errors.actionType)
                    setErrors((p) => ({ ...p, actionType: "" }));
                  if (errors.actionConfig)
                    setErrors((p) => ({ ...p, actionConfig: "" }));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select action" />
                </SelectTrigger>
                <SelectContent>
                  {ACTION_TYPES.map((at) => (
                    <SelectItem key={at.value} value={at.value}>
                      {at.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.actionType && (
                <p className="text-xs text-destructive">
                  {errors.actionType}
                </p>
              )}
            </div>

            {/* Action Config */}
            {actionType && (
              <div className="space-y-2">
                <ActionConfigForm
                  actionType={actionType}
                  actionConfig={actionConfig}
                  onChange={(config) => {
                    setActionConfig(config);
                    if (errors.actionConfig)
                      setErrors((p) => ({ ...p, actionConfig: "" }));
                  }}
                />
                {errors.actionConfig && (
                  <p className="text-xs text-destructive">
                    {errors.actionConfig}
                  </p>
                )}
              </div>
            )}

            {/* Error */}
            {mutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {mutation.error instanceof ApiError
                  ? mutation.error.message
                  : `Failed to ${isEdit ? "update" : "create"} rule. Please try again.`}
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
                  {isEdit ? "Saving..." : "Creating..."}
                </>
              ) : isEdit ? (
                "Save Changes"
              ) : (
                "Create Rule"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Delete Confirmation Dialog ----

function DeleteRuleDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: AutomationRule;
}) {
  const deleteMutation = useDeleteAutomationRule();

  async function handleDelete() {
    try {
      await deleteMutation.mutateAsync(rule.id);
      onOpenChange(false);
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Automation Rule</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the rule{" "}
            <strong>{rule.name}</strong>? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {deleteMutation.isError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {deleteMutation.error instanceof ApiError
              ? deleteMutation.error.message
              : "Failed to delete rule. Please try again."}
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
              "Delete Rule"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Rule Row ----

function RuleRow({
  rule,
  projectId,
}: {
  rule: AutomationRule;
  projectId: string;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const toggleMutation = useToggleAutomationRule();

  const builtIn = isBuiltIn(rule);

  async function handleToggle(checked: boolean) {
    try {
      await toggleMutation.mutateAsync({ id: rule.id, active: checked });
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={() => {
          if (!builtIn) setEditOpen(true);
        }}
      >
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            {rule.name}
            {builtIn && (
              <Badge
                variant="secondary"
                className="text-xs border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400"
              >
                Built-in
              </Badge>
            )}
          </div>
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="font-mono text-xs">
            {TRIGGER_EVENT_LABELS[rule.triggerEvent] ?? rule.triggerEvent}
          </Badge>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
          {summarizeConditions(rule.conditions as AutomationCondition[] | null)}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
          {summarizeAction(
            rule.actionType,
            rule.actionConfig as Record<string, unknown> | null,
          )}
        </TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={rule.isActive}
            onCheckedChange={handleToggle}
            disabled={toggleMutation.isPending}
            aria-label={`Toggle rule ${rule.name}`}
          />
        </TableCell>
        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1">
            {!builtIn && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setEditOpen(true)}
                  aria-label={`Edit rule ${rule.name}`}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDeleteOpen(true)}
                  aria-label={`Delete rule ${rule.name}`}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </>
            )}
          </div>
        </TableCell>
      </TableRow>

      {/* Edit Dialog */}
      {editOpen && (
        <RuleDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          projectId={projectId}
          rule={rule}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {deleteOpen && (
        <DeleteRuleDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          rule={rule}
        />
      )}
    </>
  );
}

// ---- Main Page ----

export function AutomationPage() {
  const params = useParams({ strict: false });
  const { currentProjectId } = useProjectStore();
  const projectId = (params as Record<string, string | undefined>).projectId ?? currentProjectId;

  const {
    data: rules,
    isLoading,
    error,
    refetch,
  } = useAutomationRules(projectId ?? undefined);
  const [createOpen, setCreateOpen] = useState(false);

  if (!projectId) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Zap className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Automation</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Zap className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium">No Project Selected</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Select a project to manage automation rules.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Zap className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Automation</h1>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New Rule
        </Button>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-destructive">
              Failed to load automation rules. Please try again.
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
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-5 w-10" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Rules table */}
      {!isLoading && !error && rules && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {rules.length} {rules.length === 1 ? "rule" : "rules"}
            </CardTitle>
            <CardDescription>
              Automation rules trigger actions when specific events occur.
              Built-in rules can be toggled but not edited or deleted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rules.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Zap className="mb-4 size-12 text-muted-foreground/50" />
                <h3 className="text-lg font-medium">No automation rules</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create your first automation rule to get started.
                </p>
                <Button
                  className="mt-4"
                  size="sm"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-4" />
                  New Rule
                </Button>
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Conditions</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="w-16">Active</TableHead>
                      <TableHead className="w-20 text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((rule) => (
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        projectId={projectId}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Create Rule Dialog */}
      <RuleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
      />
    </div>
  );
}
