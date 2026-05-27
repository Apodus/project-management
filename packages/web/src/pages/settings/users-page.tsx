import { useState } from "react";
import {
  Bot,
  Check,
  Copy,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  User as UserIcon,
  UserMinus,
  UserPlus,
  Users,
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
  DialogTrigger,
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
import {
  useUsers,
  useCreateUser,
  useUpdateUser,
  useRotateToken,
  useDeactivateUser,
  useActivateUser,
} from "@/hooks/use-users";
import { useCurrentUser } from "@/hooks/use-auth";
import { ApiError, type AuthUser, type CreateUserData, type UpdateUserData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsNav } from "@/components/settings-nav";

// ---- Token Display Dialog ----

function TokenDialog({
  open,
  onOpenChange,
  token,
  title,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  title: string;
  description: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            This token will only be shown once. Copy it now and store it securely.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all">
              {token}
            </code>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={handleCopy}
              aria-label="Copy token"
            >
              {copied ? (
                <Check className="size-4 text-green-600" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Create User Dialog ----

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createMutation = useCreateUser();

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("member");
  const [isAiAgent, setIsAiAgent] = useState(false);
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Token display after successful AI agent creation
  const [showToken, setShowToken] = useState(false);
  const [newToken, setNewToken] = useState("");

  function resetForm() {
    setUsername("");
    setDisplayName("");
    setRole("member");
    setIsAiAgent(false);
    setPassword("");
    setErrors({});
    createMutation.reset();
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!username.trim()) newErrors.username = "Username is required";
    if (!displayName.trim()) newErrors.displayName = "Display name is required";
    if (!isAiAgent && !password) newErrors.password = "Password is required for human users";
    if (!isAiAgent && password && password.length < 6) {
      newErrors.password = "Password must be at least 6 characters";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const data: CreateUserData = {
      username: username.trim(),
      displayName: displayName.trim(),
      role,
      type: isAiAgent ? "ai_agent" : "human",
      ...(isAiAgent ? {} : { password }),
    };

    try {
      const result = await createMutation.mutateAsync(data);
      if (result.apiToken) {
        setNewToken(result.apiToken);
        setShowToken(true);
      } else {
        onOpenChange(false);
        resetForm();
      }
    } catch {
      // Error is handled by mutation state
    }
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      resetForm();
      setShowToken(false);
      setNewToken("");
    }
    onOpenChange(newOpen);
  }

  // If showing the token after creation, show the token dialog instead
  if (showToken && newToken) {
    return (
      <TokenDialog
        open={open}
        onOpenChange={(newOpen) => {
          if (!newOpen) {
            handleOpenChange(false);
          }
        }}
        token={newToken}
        title="API Token Created"
        description={`API token for ${username}. Store this token securely — it cannot be retrieved later.`}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>
              Create a new user account. AI agents receive an API token for
              programmatic access.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="create-username">Username</Label>
              <Input
                id="create-username"
                placeholder="johndoe"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (errors.username) setErrors((p) => ({ ...p, username: "" }));
                }}
                autoFocus
              />
              {errors.username && (
                <p className="text-xs text-destructive">{errors.username}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-displayname">Display Name</Label>
              <Input
                id="create-displayname"
                placeholder="John Doe"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  if (errors.displayName) setErrors((p) => ({ ...p, displayName: "" }));
                }}
              />
              {errors.displayName && (
                <p className="text-xs text-destructive">{errors.displayName}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="create-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-md border px-3 py-3">
              <div className="space-y-0.5">
                <Label htmlFor="create-type" className="cursor-pointer">
                  AI Agent
                </Label>
                <p className="text-xs text-muted-foreground">
                  AI agents authenticate with API tokens instead of passwords
                </p>
              </div>
              <Switch
                id="create-type"
                checked={isAiAgent}
                onCheckedChange={(checked) => {
                  setIsAiAgent(checked === true);
                  if (checked) {
                    setPassword("");
                    setErrors((p) => ({ ...p, password: "" }));
                  }
                }}
              />
            </div>

            {!isAiAgent && (
              <div className="space-y-2">
                <Label htmlFor="create-password">Password</Label>
                <Input
                  id="create-password"
                  type="password"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errors.password) setErrors((p) => ({ ...p, password: "" }));
                  }}
                  autoComplete="new-password"
                />
                {errors.password && (
                  <p className="text-xs text-destructive">{errors.password}</p>
                )}
              </div>
            )}

            {createMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {createMutation.error instanceof ApiError
                  ? createMutation.error.message
                  : "Failed to create user. Please try again."}
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
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create User"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Edit User Dialog ----

function EditUserDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: AuthUser;
}) {
  const updateMutation = useUpdateUser();

  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState(user.role);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!username.trim()) newErrors.username = "Username is required";
    if (!displayName.trim()) newErrors.displayName = "Display name is required";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const data: UpdateUserData = {};
    if (username.trim() !== user.username) data.username = username.trim();
    if (displayName.trim() !== user.displayName) data.displayName = displayName.trim();
    if (role !== user.role) data.role = role;

    // Only send if there are actual changes
    if (Object.keys(data).length === 0) {
      onOpenChange(false);
      return;
    }

    try {
      await updateMutation.mutateAsync({ id: user.id, data });
      onOpenChange(false);
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update user details for {user.displayName}.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-username">Username</Label>
              <Input
                id="edit-username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (errors.username) setErrors((p) => ({ ...p, username: "" }));
                }}
                autoFocus
              />
              {errors.username && (
                <p className="text-xs text-destructive">{errors.username}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-displayname">Display Name</Label>
              <Input
                id="edit-displayname"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  if (errors.displayName) setErrors((p) => ({ ...p, displayName: "" }));
                }}
              />
              {errors.displayName && (
                <p className="text-xs text-destructive">{errors.displayName}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="edit-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              {user.type === "ai_agent" ? (
                <Bot className="size-4 shrink-0" />
              ) : (
                <UserIcon className="size-4 shrink-0" />
              )}
              <span>
                Type: {user.type === "ai_agent" ? "AI Agent" : "Human"} (cannot
                be changed)
              </span>
            </div>

            {updateMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {updateMutation.error instanceof ApiError
                  ? updateMutation.error.message
                  : "Failed to update user. Please try again."}
              </div>
            )}
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- User Row ----

function UserRow({ user }: { user: AuthUser }) {
  const [editOpen, setEditOpen] = useState(false);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [rotatedToken, setRotatedToken] = useState("");

  const rotateMutation = useRotateToken();
  const deactivateMutation = useDeactivateUser();
  const activateMutation = useActivateUser();

  async function handleRotateToken() {
    try {
      const result = await rotateMutation.mutateAsync(user.id);
      setRotatedToken(result.apiToken);
      setRotateConfirmOpen(false);
      setTokenDialogOpen(true);
    } catch {
      // Error handled by mutation state
    }
  }

  async function handleToggleActive() {
    if (user.isActive) {
      await deactivateMutation.mutateAsync(user.id);
    } else {
      await activateMutation.mutateAsync(user.id);
    }
  }

  const isToggling = deactivateMutation.isPending || activateMutation.isPending;

  return (
    <>
      <TableRow className={cn(!user.isActive && "opacity-60")}>
        <TableCell className="font-medium">{user.username}</TableCell>
        <TableCell>{user.displayName}</TableCell>
        <TableCell>
          <Badge
            variant="outline"
            className={cn(
              "gap-1",
              user.role === "admin"
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
            )}
          >
            {user.role === "admin" ? (
              <ShieldCheck className="size-3" />
            ) : (
              <Shield className="size-3" />
            )}
            {user.role === "admin" ? "Admin" : "Member"}
          </Badge>
        </TableCell>
        <TableCell>
          <Badge
            variant="secondary"
            className="gap-1"
          >
            {user.type === "ai_agent" ? (
              <Bot className="size-3" />
            ) : (
              <UserIcon className="size-3" />
            )}
            {user.type === "ai_agent" ? "AI Agent" : "Human"}
          </Badge>
        </TableCell>
        <TableCell>
          {user.isActive ? (
            <Badge
              variant="secondary"
              className="border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
            >
              Active
            </Badge>
          ) : (
            <Badge
              variant="secondary"
              className="border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
            >
              Inactive
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal className="size-4" />
                <span className="sr-only">Actions for {user.username}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <Pencil className="mr-2 size-4" />
                Edit
              </DropdownMenuItem>
              {user.type === "ai_agent" && (
                <DropdownMenuItem onClick={() => setRotateConfirmOpen(true)}>
                  <RefreshCw className="mr-2 size-4" />
                  Rotate Token
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleToggleActive}
                disabled={isToggling}
              >
                {user.isActive ? (
                  <>
                    <UserMinus className="mr-2 size-4" />
                    Deactivate
                  </>
                ) : (
                  <>
                    <UserPlus className="mr-2 size-4" />
                    Activate
                  </>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>

      {/* Edit Dialog */}
      <EditUserDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        user={user}
      />

      {/* Rotate Token Confirmation Dialog */}
      <Dialog open={rotateConfirmOpen} onOpenChange={setRotateConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate API Token</DialogTitle>
            <DialogDescription>
              This will invalidate the current API token for{" "}
              <strong>{user.displayName}</strong> and generate a new one. Any
              systems using the current token will stop working.
            </DialogDescription>
          </DialogHeader>
          {rotateMutation.isError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {rotateMutation.error instanceof ApiError
                ? rotateMutation.error.message
                : "Failed to rotate token. Please try again."}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRotateConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRotateToken}
              disabled={rotateMutation.isPending}
            >
              {rotateMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Rotating...
                </>
              ) : (
                "Rotate Token"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token Display Dialog */}
      {rotatedToken && (
        <TokenDialog
          open={tokenDialogOpen}
          onOpenChange={setTokenDialogOpen}
          token={rotatedToken}
          title="New API Token"
          description={`New API token for ${user.displayName}. The previous token has been revoked.`}
        />
      )}
    </>
  );
}

// ---- Main Page ----

export function UsersPage() {
  const { data: currentUser } = useCurrentUser();
  const { data: users, isLoading, error, refetch } = useUsers();
  const [createOpen, setCreateOpen] = useState(false);

  // Only admins can access this page
  if (currentUser && currentUser.role !== "admin") {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Users className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Shield className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium">Access Denied</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Only administrators can manage users.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsNav />

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          Add User
        </Button>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-destructive">
              Failed to load users. Please try again.
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
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-14" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Users table */}
      {!isLoading && !error && users && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {users.length} {users.length === 1 ? "user" : "users"}
            </CardTitle>
            <CardDescription>
              Manage user accounts, roles, and API tokens.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {users.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Users className="mb-4 size-12 text-muted-foreground/50" />
                <h3 className="text-lg font-medium">No users</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create your first user to get started.
                </p>
                <Button
                  className="mt-4"
                  size="sm"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-4" />
                  Add User
                </Button>
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Username</TableHead>
                      <TableHead>Display Name</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-12 text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <UserRow key={user.id} user={user} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Create User Dialog */}
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
