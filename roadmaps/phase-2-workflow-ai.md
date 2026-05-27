# Phase 2: Workflow & AI Interface — Roadmap

**Goal**: AI agents can autonomously pick up and complete tasks. Humans have real auth, see real-time updates, and control AI autonomy via project settings.

**Design reference**: `docs/design/high-level-design.md` — Sections 9 (AI Agent Workflow Model), 10 (Auth & Security Model), and the MCP tool specifications in Section 6.

**Prerequisites**: Phase 1 complete. 525 tests passing, 30 API endpoints, 7 MCP read tools, web UI with project/proposal/task pages.

**Design liberties**: Implementing agents may make tactical decisions within the architectural constraints. The auth model, workflow engine rules, and MCP tool signatures defined in the design doc are not negotiable.

---

## Steps

### Step 1 — Sessions table and auth middleware

Replace the auth stub with real token and session validation. After this step, API requests without valid auth are rejected (except /health and /auth/* routes).

- Add a `sessions` table to the Drizzle schema:
  - `id` TEXT (ULID) PK
  - `user_id` TEXT FK → users
  - `token_hash` TEXT (bcrypt hash of session token)
  - `expires_at` TEXT (ISO 8601)
  - `created_at` TEXT (ISO 8601)
- Generate a new migration for the sessions table
- Install `bcryptjs` + `@types/bcryptjs` in server package
- Create `packages/server/src/services/auth.service.ts`:
  - `validateApiToken(token: string): User | null` — hash the token with bcrypt compare against `users.api_token_hash`, return the user if valid
  - `createSession(userId: string): { token: string, expiresAt: string }` — generate crypto-random token, hash it, store in sessions table, return raw token
  - `validateSession(token: string): User | null` — find session by iterating (or by token prefix lookup), check not expired, return user
  - `deleteSession(token: string): void` — remove session
  - `createApiToken(userId: string): string` — generate crypto-random token, hash and store in `users.api_token_hash`, return raw token
  - `rotateApiToken(userId: string): string` — same as create but replaces existing
- Update `packages/server/src/middleware/auth.ts`:
  - Extract token from `Authorization: Bearer <token>` header → validate as API token
  - Extract token from `pm_session` cookie → validate as session
  - If valid, set user in context variables (`c.set("user", user)`)
  - If invalid or missing, return 401 `{ error: { code: "UNAUTHORIZED", message: "..." } }`
  - Skip auth for: `GET /health`, `POST /api/v1/auth/login`, `POST /api/v1/auth/setup`, `GET /api/v1/auth/setup/status`
- Update `packages/server/src/types.ts`: make `AuthUser` non-nullable in the context (since auth is now enforced)
- Update ALL existing route tests to use a real user + API token for authenticated requests. Update `createTestApp()` or `authRequest()` helper to automatically create a test user with a known API token.

**Verify**: Build passes. All existing tests updated and passing (with real auth). Unauthenticated requests to API endpoints return 401. /health remains public.

### Step 2 — User management API and auth endpoints

Create user CRUD and auth endpoints so humans can log in and admins can manage users/agents.

- Create `packages/server/src/services/user.service.ts`:
  - `list()` — list all users
  - `getById(id)` — get user (exclude password_hash and api_token_hash from response)
  - `create(data: { username, displayName, password?, role, type })` — create user. If type=human, hash password. If type=ai_agent, generate API token and return it (only time the raw token is visible).
  - `update(id, data)` — update user fields
  - `deactivate(id)` — set is_active = false
- Create `packages/server/src/routes/auth.ts`:
  - `POST /api/v1/auth/login` — body: `{ username, password }`. Validate credentials, create session, return user + set `pm_session` cookie (HttpOnly, SameSite=Strict)
  - `POST /api/v1/auth/logout` — clear session cookie, delete session from DB
  - `GET /api/v1/auth/me` — return current authenticated user
  - `GET /api/v1/auth/setup/status` — return `{ needsSetup: boolean }` (true if no users exist)
  - `POST /api/v1/auth/setup` — first-run setup: create admin user with password, return user + session. Only works if no users exist.
- Create `packages/server/src/routes/users.ts`:
  - `GET /api/v1/users` — list users (admin only)
  - `POST /api/v1/users` — create user (admin only). Return the API token in response for ai_agent users.
  - `PATCH /api/v1/users/:id` — update user (admin only)
  - `POST /api/v1/users/:id/rotate-token` — regenerate API token (admin only). Return new token.
- Add role-based authorization check: create a middleware or helper that checks `user.role === "admin"` for admin-only routes
- Register routes in app.ts

**Verify**: Build passes. Can create users via setup endpoint. Can login and get session cookie. Admin-only endpoints reject non-admin users. AI agent creation returns API token. Tests for all auth flows.

### Step 3 — Setup wizard and login UI

Add web UI for first-run setup and login.

- Create `packages/web/src/pages/setup-page.tsx`:
  - Check `/api/v1/auth/setup/status` on load
  - If `needsSetup: true`, show setup form: username, display name, password, confirm password
  - On submit, call `/api/v1/auth/setup`, then redirect to `/projects`
  - If `needsSetup: false`, redirect to login
- Create `packages/web/src/pages/login-page.tsx`:
  - Username + password form
  - On submit, call `/api/v1/auth/login`
  - On success, redirect to `/projects` (or previous page)
  - Error display for invalid credentials
- Create `packages/web/src/hooks/use-auth.ts`:
  - `useCurrentUser()` — query `/api/v1/auth/me`
  - `useLogin()` — mutation
  - `useLogout()` — mutation (clear query cache, redirect to login)
  - `useSetupStatus()` — query
- Add auth guard to the router:
  - Before rendering any authenticated route, check if user is logged in
  - If not, redirect to `/login`
  - If no users exist (setup needed), redirect to `/setup`
- Update the header component:
  - Show current user's display name
  - Logout button in user menu dropdown
- Add `/login` and `/setup` routes (outside the app shell layout — no sidebar)
- Add API client function for auth endpoints

**Verify**: Build passes. Typecheck passes. First visit redirects to /setup. After setup, can login. After login, app shell renders with user menu.

### Step 4 — User management UI

Admin page for managing human users and AI agent accounts.

- Create `packages/web/src/pages/settings/users-page.tsx`:
  - Table of all users: username, display name, role, type (human/AI badge), status (active/inactive)
  - "Add User" dialog:
    - Username, display name, role (admin/member), type (human/ai_agent)
    - If human: password field
    - If ai_agent: no password, show generated API token ONCE after creation (copy-to-clipboard)
  - "Rotate Token" button for AI agents → shows new token once
  - Deactivate/reactivate toggle
- Add `/settings/users` route under the app shell
- Update sidebar: Settings nav item links to `/settings/users`
- Add TanStack Query hooks for user management

**Verify**: Build passes. Typecheck passes. Can create human and AI agent users from UI. API tokens shown on creation.

### Step 5 — Task workflow engine

Enforce status transition rules, implement `pick_next_task`, and add autonomy guardrails. This is the core of the AI execution model.

- Update `packages/server/src/services/task.service.ts`:
  - Add `transition(taskId, toStatus, actor)`:
    - Validate transition is allowed using `TASK_TRANSITION_MAP` from @pm/shared
    - If transitioning to `in_progress`: set `started_at` if not already set
    - If transitioning to `done`: set `completed_at`
    - Log activity with status_changed action
    - Return updated task
  - Add `pickNextTask(actor, options?: { projectId?, taskTypes?, maxEffort? })`:
    - Find highest priority task where: status=ready, not blocked (no unresolved blocking deps), not assigned
    - If projectId specified, scope to that project
    - If taskTypes specified, filter by type
    - If maxEffort specified, filter by effort <= maxEffort (xs < s < m < l < xl)
    - Atomically (in a transaction): assign to actor, set status to in_progress, set started_at
    - Check autonomy guardrails: `max_concurrent_tasks` for this agent in this project
    - Return the claimed task, or null if nothing available
  - Modify `update()` to prevent direct status changes via PATCH — status must go through `transition()` or `pickNextTask()`
- Add `POST /api/v1/tasks/:id/transitions` route:
  - Body: `{ to_status: string, comment?: string }`
  - Uses the authenticated user as the actor
  - Optionally creates a comment with the transition
- Add `POST /api/v1/tasks/pick-next` route:
  - Body: `{ project_id?, task_types?, max_effort? }`
  - Returns the claimed task or 404 if nothing available
  - Only available to AI agent users (enforce user.type === "ai_agent")
- Add autonomy guardrail checks:
  - Before any AI action, check the project's `settings.ai_autonomy` config
  - `can_self_assign` → required for pick_next_task
  - `can_create_subtasks` → checked when creating subtasks
  - `can_create_tasks` → checked when creating top-level tasks
  - `can_change_priority` → checked when updating priority
  - Return 403 with descriptive message when guardrail blocks action
- Update task list endpoint: add `is_blocked` computation to task responses (include a boolean field)

**Verify**: Build passes. Tests for every valid transition, every invalid transition rejected, pick_next_task atomicity (no double-claim), autonomy guardrail enforcement, concurrent task limit. Existing tests still pass.

### Step 6 — MCP write tools: proposals and workflow

Add the MCP tools that let AI agents create work from proposals and manage task lifecycle.

- Add to `packages/mcp-server/src/api-client.ts`:
  - `implementProposal(proposalId, data)` — POST /api/v1/proposals/:id/implement (or whatever endpoint exists)
  - `transitionTask(taskId, toStatus, comment?)` — POST /api/v1/tasks/:id/transitions
  - `pickNextTask(options?)` — POST /api/v1/tasks/pick-next
  - `createTask(projectId, data)` — POST /api/v1/projects/:projectId/tasks
  - `updateTask(taskId, data)` — PATCH /api/v1/tasks/:id
  - `addTaskComment(taskId, body, type?, metadata?)` — POST /api/v1/tasks/:taskId/comments

- Add MCP tools in `packages/mcp-server/src/tools/`:
  - **`pm_implement_proposal`** — Create epics/tasks from an accepted proposal. Parameters: proposal_id, epics (array with name, description, tasks), tasks (standalone). Calls implementProposal API.
  - **`pm_pick_next_task`** — Find and self-assign highest priority ready task. Parameters: project_id?, task_types?, max_effort?. Returns full task details or "nothing available" message.
  - **`pm_start_task`** — Claim a specific task. Parameters: task_id, comment?. Calls transition to in_progress.
  - **`pm_complete_task`** — Mark task done with handoff. Parameters: task_id, summary, files_changed?, open_questions?, test_results?. Transitions to done, adds handoff comment.
  - **`pm_request_review`** — Move task to in_review. Parameters: task_id, summary, review_notes?, files_changed?. Transitions to in_review, adds review comment.
  - **`pm_block_task`** — Mark as blocked. Parameters: task_id, reason, blocked_by_task_id?. Adds comment, optionally creates dependency.

- Integration tests for all new tools

**Verify**: Build passes. All MCP tool tests pass. Can complete full AI workflow: pick_next_task → start → complete via MCP.

### Step 7 — MCP write tools: context, communication, and remaining tools

Complete the MCP tool set so AI agents have full capability.

- Add API client functions for remaining endpoints
- Add MCP tools:
  - **`pm_create_task`** — Create a new task (for breaking down work). Parameters: project_id, title, description?, epic_id?, parent_task_id?, priority?, type?, estimated_effort?, context?, depends_on?
  - **`pm_update_task`** — Update task fields. Parameters: task_id, title?, description?, priority?, type?, estimated_effort?, context?, due_date?
  - **`pm_add_comment`** — Add a typed comment. Parameters: task_id, body, comment_type?, metadata?
  - **`pm_log_decision`** — Record a design decision. Parameters: task_id, decision, rationale, alternatives_considered?. Creates a decision-type comment with structured metadata.
  - **`pm_report_progress`** — Post progress update. Parameters: task_id, summary, completion_pct?, files_changed?, blockers?. Creates a progress_update comment.
  - **`pm_set_task_context`** — Update AI context on a task. Parameters: task_id, relevant_files?, acceptance_criteria?, notes?, implementation_hints?, design_references?. Merges with existing context.
  - **`pm_link_git_ref`** — Link a git ref to a task. Parameters: task_id, ref_type, ref_value, url?, title?

- Integration tests for all tools
- Update MCP resources:
  - `pm://project/{id}/board` — tasks grouped by status (kanban-style)

**Verify**: Build passes. All MCP tools work. Full AI agent workflow possible: list proposals → discuss → implement → pick task → plan (create subtasks, log decisions) → execute (progress, git refs) → complete (handoff).

### Step 8 — Event bus and activity log refactor

Create an in-process event system that decouples mutations from side effects. This prepares for SSE streaming.

- Create `packages/server/src/events/event-bus.ts`:
  - Typed EventEmitter with event types:
    - `project.created`, `project.updated`, `project.archived`
    - `proposal.created`, `proposal.transitioned`, `proposal.commented`, `proposal.implemented`
    - `epic.created`, `epic.updated`, `epic.archived`
    - `task.created`, `task.updated`, `task.status_changed`, `task.assigned`, `task.commented`, `task.archived`
    - `comment.created`, `comment.updated`, `comment.deleted`
  - Each event payload includes: entity data, actor, timestamp, changes (for updates)
  - `getEventBus()` singleton
- Create `packages/server/src/events/listeners.ts`:
  - Activity log listener: on any entity event, write to activity_log table
  - This replaces the inline `logActivity()` calls currently scattered across services
- Refactor existing services:
  - Remove direct `logActivity()` calls from services
  - Instead, emit events from services: `eventBus.emit("task.status_changed", { ... })`
  - The listener handles activity log writes
- Register listeners in the app initialization

**Verify**: Build passes. All existing tests pass (activity logging still works, just via events now). Event bus is testable in isolation.

### Step 9 — SSE endpoint and frontend real-time updates

Server-Sent Events for live updates in the web UI.

- Create `packages/server/src/routes/events.ts`:
  - `GET /api/v1/events` — SSE stream
  - Query param: `project_id` to scope events
  - On connection: register a listener on the event bus
  - On event: send SSE message in format: `event: <type>\ndata: <json>\n\n`
  - On disconnect: unregister listener
  - Auth required (use session or API token)
- Create `packages/web/src/lib/sse.ts`:
  - `useSSE(projectId?)` — custom hook that:
    - Opens EventSource connection to `/api/v1/events?project_id=...`
    - On message: invalidate relevant TanStack Query caches
    - E.g., `task.updated` → invalidate task queries
    - `proposal.commented` → invalidate proposal comment queries
    - Auto-reconnect on connection loss
  - Mount this hook in the app shell layout so it runs globally
- Add toast notifications for key events:
  - "Task X completed by Agent Y"
  - "Proposal X accepted"
  - Use Sonner toast from shadcn/ui

**Verify**: Build passes. SSE endpoint streams events. Frontend receives events and refreshes data. Toast notifications appear for key events.

### Step 10 — Activity feed page and final polish

Complete the web UI with the activity feed and polish remaining pages.

- Create `packages/web/src/pages/activity-page.tsx`:
  - Chronological list of all activity for the current project
  - Each entry shows: icon (by action type), entity type badge, description ("User X created task Y"), relative timestamp
  - Filter by entity type dropdown
  - Filter by actor dropdown
  - Pagination
  - Visual distinction: human vs AI actor
- Update sidebar: Activity nav link works
- Update dashboard placeholder:
  - Show project stats (task counts by status) using project stats API
  - Show recent activity (last 10 items)
  - Show "my tasks" (tasks assigned to current user)
  - Show "blocked tasks" alert count
- Add the API client functions and hooks for activity endpoints
- Final review: ensure all pages handle loading, error, and empty states consistently

**Verify**: Build passes. Typecheck passes. Full build succeeds. Activity feed shows real data. Dashboard shows project health.

---

## Dependency DAG

```
depends_on:
  step_2: [step_1]
  step_3: [step_2]
  step_4: [step_2]
  step_5: [step_1]
  step_6: [step_5]
  step_7: [step_6]
  step_8: [step_5]
  step_9: [step_8]
  step_10: [step_3, step_9]
```

### Parallelism notes

- **Steps 3 and 4** (setup wizard UI + user management UI) can run in parallel after Step 2.
- **Steps 5 and 3/4** are independent — workflow engine doesn't need UI, UI doesn't need workflow engine. But both depend on Step 1 (auth).
- **Steps 6 and 8** can start in parallel after Step 5 — MCP write tools and event bus are independent.
- **Step 10** needs both the auth UI (Step 3) and SSE (Step 9) done.

### Critical path

```
1 → 2 → 3 ───────────────────────────────→ 10
    ↓                                        ↑
    → 4                                      │
1 → 5 → 6 → 7                               │
    ↓                                        │
    → 8 → 9 ────────────────────────────────→ 10
```

Longest path: 1 → 5 → 6 → 7 (then wait for 8 → 9 → 10) — 7 sequential steps.
