import { useState } from "react";
import {
  Bot,
  Check,
  CircleDot,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  Trash2,
  Unlock,
  User as UserIcon,
  UserMinus,
  UserPlus,
  Users,
  Wifi,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useUsers,
  useCreateUser,
  useUpdateUser,
  useRotateToken,
  useDeactivateUser,
  useActivateUser,
} from "@/hooks/use-users";
import {
  useAgentPools,
  useAgentPool,
  useCreatePool,
  useDeletePool,
  useUpdatePoolSecret,
  useCreatePoolAgents,
  useForceReleaseAgent,
  useRemoveAgentFromPool,
} from "@/hooks/use-agent-pool";
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

// ---- Create Human User Dialog ----

function CreateHumanUserDialog({
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
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function resetForm() {
    setUsername("");
    setDisplayName("");
    setRole("member");
    setPassword("");
    setErrors({});
    createMutation.reset();
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!username.trim()) newErrors.username = "Username is required";
    if (!displayName.trim()) newErrors.displayName = "Display name is required";
    if (!password) newErrors.password = "Password is required";
    if (password && password.length < 6) {
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
      type: "human",
      password,
    };

    try {
      await createMutation.mutateAsync(data);
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
            <DialogTitle>Add Human User</DialogTitle>
            <DialogDescription>
              Create a new human user account with password authentication.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="create-human-username">Username</Label>
              <Input
                id="create-human-username"
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
              <Label htmlFor="create-human-displayname">Display Name</Label>
              <Input
                id="create-human-displayname"
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
              <Label htmlFor="create-human-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="create-human-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-human-password">Password</Label>
              <Input
                id="create-human-password"
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

// ---- Create Individual Agent Dialog ----

function CreateIndividualAgentDialog({
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
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [showToken, setShowToken] = useState(false);
  const [newToken, setNewToken] = useState("");

  function resetForm() {
    setUsername("");
    setDisplayName("");
    setRole("member");
    setErrors({});
    createMutation.reset();
  }

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

    const data: CreateUserData = {
      username: username.trim(),
      displayName: displayName.trim(),
      role,
      type: "ai_agent",
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
      // Error handled by mutation state
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

  if (showToken && newToken) {
    return (
      <TokenDialog
        open={open}
        onOpenChange={(newOpen) => {
          if (!newOpen) handleOpenChange(false);
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
            <DialogTitle>Add Individual Agent</DialogTitle>
            <DialogDescription>
              Create an AI agent with a static API token. Use this for agents that
              connect with their own dedicated token (PM_API_TOKEN).
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="create-agent-username">Username</Label>
              <Input
                id="create-agent-username"
                placeholder="claude-agent"
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
              <Label htmlFor="create-agent-displayname">Display Name</Label>
              <Input
                id="create-agent-displayname"
                placeholder="Claude Agent"
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
              <Label htmlFor="create-agent-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="create-agent-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {createMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {createMutation.error instanceof ApiError
                  ? createMutation.error.message
                  : "Failed to create agent. Please try again."}
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
                "Create Agent"
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

// ---- Create Pool Dialog ----

function CreatePoolDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createPoolMutation = useCreatePool();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function resetForm() {
    setName("");
    setSecret("");
    setDescription("");
    setErrors({});
    createPoolMutation.reset();
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = "Pool name is required";
    if (!secret.trim()) newErrors.secret = "Secret is required";
    if (secret.trim().length > 0 && secret.trim().length < 8) {
      newErrors.secret = "Secret must be at least 8 characters";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    try {
      await createPoolMutation.mutateAsync({
        name: name.trim(),
        secret: secret.trim(),
        description: description.trim() || undefined,
      });
      handleOpenChange(false);
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="size-5" />
              Create Agent Pool
            </DialogTitle>
            <DialogDescription>
              Create a named pool with its own secret. Agents can be added after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pool-name">Pool Name</Label>
              <Input
                id="pool-name"
                placeholder="e.g. game-team, default"
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

            <div className="space-y-2">
              <Label htmlFor="pool-secret">Pool Secret</Label>
              <Input
                id="pool-secret"
                type="password"
                placeholder="Enter a strong secret (min 8 characters)"
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value);
                  if (errors.secret) setErrors((p) => ({ ...p, secret: "" }));
                }}
                autoComplete="off"
              />
              {errors.secret && (
                <p className="text-xs text-destructive">{errors.secret}</p>
              )}
              <p className="text-xs text-muted-foreground">
                This secret will not be shown again after creation. Store it securely.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pool-description">Description (optional)</Label>
              <Input
                id="pool-description"
                placeholder="What is this pool for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {createPoolMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {createPoolMutation.error instanceof ApiError
                  ? createPoolMutation.error.message
                  : "Failed to create pool. Please try again."}
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
            <Button type="submit" disabled={createPoolMutation.isPending}>
              {createPoolMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Pool"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Update Pool Secret Dialog ----

function UpdatePoolSecretDialog({
  open,
  onOpenChange,
  poolId,
  poolName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolId: string;
  poolName: string;
}) {
  const updateSecretMutation = useUpdatePoolSecret();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      setSecret("");
      setError("");
      updateSecretMutation.reset();
    }
    onOpenChange(newOpen);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!secret.trim()) {
      setError("Secret is required");
      return;
    }
    if (secret.trim().length < 8) {
      setError("Secret must be at least 8 characters");
      return;
    }

    try {
      await updateSecretMutation.mutateAsync({ poolId, secret: secret.trim() });
      handleOpenChange(false);
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="size-5" />
              Update Secret for "{poolName}"
            </DialogTitle>
            <DialogDescription>
              Set a new shared secret for this pool. Existing agents will need
              to use the new secret on their next claim.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="update-pool-secret">New Secret</Label>
              <Input
                id="update-pool-secret"
                type="password"
                placeholder="Enter a strong secret (min 8 characters)"
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value);
                  setError("");
                }}
                autoFocus
                autoComplete="off"
              />
              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}
            </div>

            {updateSecretMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {updateSecretMutation.error instanceof ApiError
                  ? updateSecretMutation.error.message
                  : "Failed to update secret. Please try again."}
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
            <Button type="submit" disabled={updateSecretMutation.isPending}>
              {updateSecretMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Update Secret"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Add Agents to Pool Dialog ----

function AddPoolAgentsDialog({
  open,
  onOpenChange,
  poolId,
  poolName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolId: string;
  poolName: string;
}) {
  const createAgentsMutation = useCreatePoolAgents();
  const [count, setCount] = useState(5);
  const [namePrefix, setNamePrefix] = useState("");
  const [error, setError] = useState("");

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      setCount(5);
      setNamePrefix("");
      setError("");
      createAgentsMutation.reset();
    }
    onOpenChange(newOpen);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (count < 1 || count > 20) {
      setError("Count must be between 1 and 20");
      return;
    }

    try {
      await createAgentsMutation.mutateAsync({
        poolId,
        count,
        namePrefix: namePrefix.trim() || undefined,
      });
      handleOpenChange(false);
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="size-5" />
              Add Agents to "{poolName}"
            </DialogTitle>
            <DialogDescription>
              Create AI agent identities in this pool. They will be claimed
              dynamically via the pool secret.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-agents-count">Number of Agents</Label>
              <Input
                id="add-agents-count"
                type="number"
                min={1}
                max={20}
                value={count}
                onChange={(e) => {
                  setCount(parseInt(e.target.value) || 1);
                  setError("");
                }}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Between 1 and 20 agents.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="add-agents-prefix">Name Prefix (optional)</Label>
              <Input
                id="add-agents-prefix"
                placeholder={`Leave empty for "${poolName}-Alpha", "${poolName}-Beta"...`}
                value={namePrefix}
                onChange={(e) => setNamePrefix(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}

            {createAgentsMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {createAgentsMutation.error instanceof ApiError
                  ? createAgentsMutation.error.message
                  : "Failed to add agents. Please try again."}
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
            <Button type="submit" disabled={createAgentsMutation.isPending}>
              {createAgentsMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                `Create ${count} Agent${count !== 1 ? "s" : ""}`
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Human User Row ----

function HumanUserRow({ user }: { user: AuthUser }) {
  const [editOpen, setEditOpen] = useState(false);
  const deactivateMutation = useDeactivateUser();
  const activateMutation = useActivateUser();

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

      <EditUserDialog open={editOpen} onOpenChange={setEditOpen} user={user} />
    </>
  );
}

// ---- Individual Agent Row ----

function IndividualAgentRow({ user }: { user: AuthUser }) {
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
          <span className="font-mono text-xs text-muted-foreground">
            {"••••••••"}
          </span>
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
              <DropdownMenuItem onClick={() => setRotateConfirmOpen(true)}>
                <RefreshCw className="mr-2 size-4" />
                Rotate Token
              </DropdownMenuItem>
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

      <EditUserDialog open={editOpen} onOpenChange={setEditOpen} user={user} />

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

// ---- Pool Agent Row (with inline edit) ----

function PoolAgentRow({
  agent,
  poolId,
}: {
  agent: {
    user: { id: string; username: string; displayName: string; type: string; isActive: boolean; poolId: string | null };
    claimed: boolean;
    claimedAt: string | null;
    expiresAt: string | null;
    heartbeatAt: string | null;
  };
  poolId: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(agent.user.displayName);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const updateMutation = useUpdateUser();
  const forceReleaseMutation = useForceReleaseAgent();
  const deactivateMutation = useDeactivateUser();
  const activateMutation = useActivateUser();
  const removeMutation = useRemoveAgentFromPool();

  function formatTime(iso: string | null): string {
    if (!iso) return "-";
    const date = new Date(iso);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatRelative(iso: string | null): string {
    if (!iso) return "-";
    const date = new Date(iso);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 0) return "expired";
    if (diffMin < 1) return "< 1 min";
    if (diffMin < 60) return `${diffMin} min`;
    return `${Math.round(diffMin / 60)}h ${diffMin % 60}m`;
  }

  async function handleSaveName() {
    if (!editName.trim() || editName.trim() === agent.user.displayName) {
      setIsEditing(false);
      setEditName(agent.user.displayName);
      return;
    }
    try {
      await updateMutation.mutateAsync({
        id: agent.user.id,
        data: { displayName: editName.trim() },
      });
      setIsEditing(false);
    } catch {
      // Revert on error
      setEditName(agent.user.displayName);
      setIsEditing(false);
    }
  }

  async function handleForceRelease() {
    await forceReleaseMutation.mutateAsync(agent.user.id);
  }

  async function handleToggleActive() {
    if (agent.user.isActive) {
      await deactivateMutation.mutateAsync(agent.user.id);
    } else {
      await activateMutation.mutateAsync(agent.user.id);
    }
  }

  async function handleRemove() {
    try {
      await removeMutation.mutateAsync({ poolId, userId: agent.user.id });
      setDeleteConfirmOpen(false);
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <>
      <TableRow className={cn(!agent.user.isActive && "opacity-60")}>
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            <Bot className="size-4 shrink-0 text-muted-foreground" />
            {isEditing ? (
              <div className="flex items-center gap-1">
                <Input
                  className="h-7 w-40 text-sm"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveName();
                    if (e.key === "Escape") {
                      setEditName(agent.user.displayName);
                      setIsEditing(false);
                    }
                  }}
                  autoFocus
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleSaveName}
                  disabled={updateMutation.isPending}
                >
                  <Check className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    setEditName(agent.user.displayName);
                    setIsEditing(false);
                  }}
                >
                  <X className="size-3" />
                </Button>
              </div>
            ) : (
              <button
                className="group flex items-center gap-1 text-left hover:underline"
                onClick={() => setIsEditing(true)}
                title="Click to rename"
              >
                {agent.user.displayName}
                <Pencil className="size-3 opacity-0 group-hover:opacity-50" />
              </button>
            )}
          </div>
        </TableCell>
        <TableCell>
          {!agent.user.isActive ? (
            <Badge
              variant="secondary"
              className="border-gray-500/30 bg-gray-500/10 text-gray-700 dark:text-gray-400"
            >
              Inactive
            </Badge>
          ) : agent.claimed ? (
            <Badge
              variant="secondary"
              className="gap-1 border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400"
            >
              <CircleDot className="size-3" />
              Claimed
            </Badge>
          ) : (
            <Badge
              variant="secondary"
              className="gap-1 border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
            >
              Available
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {formatTime(agent.claimedAt)}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {formatTime(agent.heartbeatAt)}
        </TableCell>
        <TableCell className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal className="size-4" />
                <span className="sr-only">Actions for {agent.user.displayName}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setIsEditing(true)}>
                <Pencil className="mr-2 size-4" />
                Rename
              </DropdownMenuItem>
              {agent.claimed && (
                <DropdownMenuItem
                  onClick={handleForceRelease}
                  disabled={forceReleaseMutation.isPending}
                >
                  <Unlock className="mr-2 size-4" />
                  Force Release
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleToggleActive}
                disabled={deactivateMutation.isPending || activateMutation.isPending}
              >
                {agent.user.isActive ? (
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
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setDeleteConfirmOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 size-4" />
                Remove from Pool
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Agent from Pool</DialogTitle>
            <DialogDescription>
              Remove <strong>{agent.user.displayName}</strong> from this pool?
              If the agent has existing activity (comments, task assignments, etc.),
              it will be deactivated and removed from the pool instead of deleted.
            </DialogDescription>
          </DialogHeader>
          {removeMutation.isError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {removeMutation.error instanceof ApiError
                ? removeMutation.error.message
                : "Failed to remove agent. Please try again."}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove Agent"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---- Human Users Section ----

function HumanUsersSection({ users }: { users: AuthUser[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const humanUsers = users.filter((u) => u.type === "human");

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserIcon className="size-4" />
              Human Users
            </CardTitle>
            <CardDescription>
              {humanUsers.length} user{humanUsers.length !== 1 ? "s" : ""} with password authentication.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Add Human User
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {humanUsers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8">
            <UserIcon className="mb-3 size-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No human users yet.</p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-4" />
              Add Human User
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
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {humanUsers.map((user) => (
                  <HumanUserRow key={user.id} user={user} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <CreateHumanUserDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Card>
  );
}

// ---- Individual Agents Section ----

function IndividualAgentsSection({ users }: { users: AuthUser[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const individualAgents = users.filter(
    (u) => u.type === "ai_agent" && !u.poolId,
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="size-4" />
              Individual Agents
            </CardTitle>
            <CardDescription>
              {individualAgents.length} agent{individualAgents.length !== 1 ? "s" : ""} with
              static API tokens (PM_API_TOKEN).
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Add Individual Agent
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {individualAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8">
            <Bot className="mb-3 size-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No individual agents yet.</p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-4" />
              Add Individual Agent
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
                  <TableHead>API Token</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {individualAgents.map((user) => (
                  <IndividualAgentRow key={user.id} user={user} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <CreateIndividualAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Card>
  );
}

// ---- Pool Card (individual pool within the section) ----

function PoolCard({
  pool,
}: {
  pool: {
    id: string;
    name: string;
    description: string | null;
    agentCount: number;
    claimedCount: number;
    availableCount: number;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [addAgentsOpen, setAddAgentsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const deleteMutation = useDeletePool();

  const { data: poolDetail } = useAgentPool(expanded ? pool.id : "");

  async function handleDelete() {
    try {
      await deleteMutation.mutateAsync(pool.id);
      setDeleteConfirmOpen(false);
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          className="flex flex-1 items-center gap-3 text-left"
          onClick={() => setExpanded(!expanded)}
        >
          <Server className="size-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="font-medium">{pool.name}</div>
            {pool.description && (
              <div className="text-xs text-muted-foreground">{pool.description}</div>
            )}
          </div>
          <div className="ml-4 flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {pool.agentCount} agent{pool.agentCount !== 1 ? "s" : ""}
            </Badge>
            <Badge
              variant="secondary"
              className="border-green-500/30 bg-green-500/10 text-xs text-green-700 dark:text-green-400"
            >
              {pool.availableCount} available
            </Badge>
            {pool.claimedCount > 0 && (
              <Badge
                variant="secondary"
                className="border-blue-500/30 bg-blue-500/10 text-xs text-blue-700 dark:text-blue-400"
              >
                {pool.claimedCount} claimed
              </Badge>
            )}
            {pool.agentCount - pool.availableCount - pool.claimedCount > 0 && (
              <Badge
                variant="secondary"
                className="border-gray-500/30 bg-gray-500/10 text-xs text-gray-700 dark:text-gray-400"
              >
                {pool.agentCount - pool.availableCount - pool.claimedCount} inactive
              </Badge>
            )}
          </div>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <MoreHorizontal className="size-4" />
              <span className="sr-only">Actions for {pool.name}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setAddAgentsOpen(true)}>
              <UserPlus className="mr-2 size-4" />
              Add Agents
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSecretOpen(true)}>
              <Lock className="mr-2 size-4" />
              Update Secret
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setDeleteConfirmOpen(true)}
              className="text-destructive focus:text-destructive"
            >
              <X className="mr-2 size-4" />
              Delete Pool
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded && poolDetail && (
        <div className="border-t px-4 py-3">
          {poolDetail.agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-sm text-muted-foreground">
              <Bot className="mb-2 size-8 text-muted-foreground/50" />
              No agents in this pool yet.
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => setAddAgentsOpen(true)}
              >
                <Plus className="size-4" />
                Add Agents to Pool
              </Button>
            </div>
          ) : (
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {poolDetail.agents.length} agent{poolDetail.agents.length !== 1 ? "s" : ""} in pool
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAddAgentsOpen(true)}
              >
                <UserPlus className="size-4" />
                Add Agents to Pool
              </Button>
            </div>
          )}
          {poolDetail.agents.length > 0 && (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Claimed Since</TableHead>
                    <TableHead>Heartbeat</TableHead>
                    <TableHead className="w-12 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {poolDetail.agents.map((agent) => (
                    <PoolAgentRow key={agent.user.id} agent={agent} poolId={pool.id} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <UpdatePoolSecretDialog
        open={secretOpen}
        onOpenChange={setSecretOpen}
        poolId={pool.id}
        poolName={pool.name}
      />
      <AddPoolAgentsDialog
        open={addAgentsOpen}
        onOpenChange={setAddAgentsOpen}
        poolId={pool.id}
        poolName={pool.name}
      />

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Pool "{pool.name}"</DialogTitle>
            <DialogDescription>
              This will delete the pool and deactivate all {pool.agentCount} agent{pool.agentCount !== 1 ? "s" : ""} in it.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteMutation.isError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteMutation.error instanceof ApiError
                ? deleteMutation.error.message
                : "Failed to delete pool. Please try again."}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
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
                "Delete Pool"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Agent Pool Section ----

function AgentPoolSection() {
  const { data: pools, isLoading } = useAgentPools();
  const [createPoolOpen, setCreatePoolOpen] = useState(false);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const poolList = pools ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wifi className="size-4" />
              Agent Pools
            </CardTitle>
            <CardDescription>
              {poolList.length === 0
                ? "No pools configured. Create a pool to get started."
                : `${poolList.length} pool${poolList.length !== 1 ? "s" : ""}`}
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreatePoolOpen(true)}>
            <Plus className="size-4" />
            Create Pool
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {poolList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8">
            <Server className="mb-3 size-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No pools yet.</p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => setCreatePoolOpen(true)}
            >
              <Plus className="size-4" />
              Create Pool
            </Button>
          </div>
        ) : (
          poolList.map((pool) => <PoolCard key={pool.id} pool={pool} />)
        )}
      </CardContent>

      <CreatePoolDialog open={createPoolOpen} onOpenChange={setCreatePoolOpen} />
    </Card>
  );
}

// ---- Main Page ----

export function UsersPage() {
  const { data: currentUser } = useCurrentUser();
  const { data: users, isLoading, error, refetch } = useUsers();

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
      <div className="flex items-center gap-3">
        <Users className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Users & Agents</h1>
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

      {/* Main content */}
      {!isLoading && !error && users && (
        <>
          {/* Section 1: Human Users */}
          <HumanUsersSection users={users} />

          {/* Section 2: AI Agents */}
          <div className="space-y-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Bot className="size-5 text-muted-foreground" />
              AI Agents
            </h2>

            <Tabs defaultValue="pool" className="w-full">
              <TabsList>
                <TabsTrigger value="pool">
                  <Wifi className="size-4" />
                  Agent Pool
                </TabsTrigger>
                <TabsTrigger value="individual">
                  <Bot className="size-4" />
                  Individual Agents
                </TabsTrigger>
              </TabsList>
              <TabsContent value="pool">
                <AgentPoolSection />
              </TabsContent>
              <TabsContent value="individual">
                <IndividualAgentsSection users={users} />
              </TabsContent>
            </Tabs>
          </div>
        </>
      )}
    </div>
  );
}
