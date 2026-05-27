# Phase 1: Foundation — Roadmap

**Goal**: End-to-end system running. A human can create proposals and discuss with AI via the web UI. An AI agent can read proposals and tasks via MCP.

**Design reference**: `docs/design/high-level-design.md` — all specifications (data model, API contracts, project structure, tech stack) are authoritative. When in doubt, read the design doc.

**Design liberties**: Implementing agents may make tactical decisions (internal file organization, helper function signatures, component decomposition, test structure) as long as they stay within the architectural constraints in the design doc. The tech stack, data model, API contracts, and project structure are not negotiable.

---

## Steps

### Step 1 — Monorepo scaffolding

Initialize the monorepo with all tooling. After this step, `pnpm install` works and `pnpm build` runs (even if packages are empty shells).

- Initialize pnpm workspace with `pnpm-workspace.yaml` listing `packages/*`
- Root `package.json` with workspace scripts (`dev`, `build`, `test`, `lint`, `typecheck`)
- `turbo.json` with build/test/lint pipeline configuration
- `tsconfig.base.json` with shared TypeScript settings (strict, ESNext, path aliases)
- Per-package scaffolds with their own `tsconfig.json`, `package.json`, and `src/index.ts`:
  - `packages/shared` — exports nothing yet, but compiles
  - `packages/server` — empty Hono app that starts and responds to GET /health
  - `packages/web` — Vite + React app with a "Hello World" page
  - `packages/mcp-server` — empty entry point that exits cleanly
- ESLint 9 flat config + Prettier config at root
- `.gitignore` (node_modules, dist, data/, *.db)
- Minimal `CLAUDE.md` with build/test/lint commands

**Verify**: `pnpm install && pnpm build && pnpm lint && pnpm typecheck` all pass. Server starts and responds to `/health`.

### Step 2 — Shared package: schemas, types, constants

Define all Zod schemas and TypeScript types in `packages/shared`. This is the single source of truth for the data model. Every other package imports from here.

- Zod schemas for every entity defined in design doc Section 4:
  - Workspace, User, Project, Proposal, Epic, Task, Comment, Label, TaskLabel, TaskDependency, ActivityLog, GitRef, Milestone
  - Include insert schemas (for creation — omit id, timestamps) and select schemas (full entity)
  - JSON sub-schemas: project settings, task context, comment metadata variants
- TypeScript types inferred from Zod schemas (`z.infer<>`)
- Constants:
  - Status enums: project statuses, proposal statuses, epic statuses, task statuses, milestone statuses
  - Priority enum, task type enum, effort size enum, user role enum, user type enum
  - Comment type enum, dependency type enum, git ref type enum
  - Proposal status transition rules (which transitions are valid, which require human role)
  - Task status transition rules
- ULID generation utility (wrap `ulid` package)
- Export everything from package root

**Verify**: `pnpm build --filter shared` passes. Types are importable. Zod schemas validate sample data correctly. Unit tests for schema validation (valid and invalid inputs) and status transition rules.

### Step 3 — Database schema and migrations

Set up Drizzle ORM with SQLite, define all tables, and create the initial migration.

- Install `drizzle-orm`, `better-sqlite3`, `drizzle-kit` in `packages/server`
- Drizzle schema file (`packages/server/src/db/schema.ts`) defining all tables from design doc Section 4, using the shared constants for enum-like TEXT columns
- All indexes from design doc Section 4 (including FTS5 virtual tables)
- `drizzle.config.ts` for migration generation
- Generate initial migration
- Database initialization module:
  - Creates DB file at configured path (env var `PM_DB_PATH`, default `./data/pm.db`)
  - Enables WAL mode
  - Runs migrations on startup
  - Seeds default workspace if none exists
- Export `getDb()` function that returns the initialized Drizzle instance

**Verify**: `pnpm build --filter server` passes. A test that initializes an in-memory SQLite DB, runs migrations, and verifies all tables exist. Seed data creates a default workspace.

### Step 4 — Server foundation: Hono app, middleware, error handling

Set up the Hono application with OpenAPI integration, middleware stack, and error handling. After this step, the server is a running app with structured error responses and OpenAPI spec generation — but no business routes yet.

- Hono app with `@hono/zod-openapi` integration
- Middleware stack:
  - Request ID generation (ULID per request)
  - Request logging (method, path, status, duration)
  - CORS (permissive for local dev)
  - Error handling (catches all errors, returns consistent JSON envelope from design doc Section 5)
- Auth middleware (stub for now — extracts token from Authorization header or session cookie, but doesn't validate yet. Attaches a placeholder user context to the request)
- OpenAPI spec served at `/api/v1/openapi.json`
- Swagger UI at `/api/v1/docs` (using `@hono/swagger-ui` or scalar)
- Server entry point (`packages/server/src/index.ts`):
  - Reads `PM_PORT`, `PM_HOST`, `PM_DB_PATH` from env
  - Initializes DB
  - Starts Hono on configured port
  - Graceful shutdown handler
- Test utilities module (`packages/server/tests/utils.ts`):
  - `createTestApp()` — returns Hono app with in-memory SQLite
  - `createTestUser()`, `createTestProject()` — factory functions for test data
  - Helper to make authenticated test requests

**Verify**: Server starts, `/health` returns 200, `/api/v1/openapi.json` returns valid OpenAPI spec, `/api/v1/docs` renders. Error middleware returns correct JSON envelope for 404 and 500 errors. Test utilities work.

### Step 5 — API: Projects CRUD

Full project management endpoints with service layer pattern.

- Service layer (`packages/server/src/services/project.service.ts`):
  - `list(filters)`, `getById(id)`, `create(data)`, `update(id, data)`, `archive(id)`, `getStats(id)`
  - Stats: count tasks by status, count epics, count proposals
- Route handlers (`packages/server/src/routes/projects.ts`):
  - All project endpoints from design doc Section 5
  - OpenAPI route definitions with Zod request/response schemas
  - Slug generation from project name
- Integration tests covering:
  - CRUD happy paths
  - Validation errors (missing required fields, invalid status)
  - Archive behavior (soft delete)
  - Stats computation
  - Filtering by status

**Verify**: All tests pass. API returns correct response envelopes. OpenAPI spec includes project endpoints.

### Step 6 — API: Proposals with transitions and role enforcement

Proposal CRUD plus the role-enforced status transition system. This is the most complex API in Phase 1 — the transition logic is the core of the human-AI design workflow.

- Service layer (`packages/server/src/services/proposal.service.ts`):
  - `list(projectId, filters)`, `getById(id)` (with comments and linked work items), `create(data)`, `update(id, data)`
  - `transition(id, toStatus, actorType)` — enforces rules from design doc Section 4 (proposals table):
    - Only humans can transition to `accepted` or `rejected`
    - AI can transition `open` → `discussing` and `accepted` → `implemented`
    - Invalid transitions return clear errors
  - `addComment(proposalId, data)` — auto-transitions `open` → `discussing` when AI comments
  - `getWorkItems(proposalId)` — list epics and tasks spawned from this proposal
  - `implementProposal(proposalId, epics, tasks)` — atomically creates work items and transitions to `implemented`
- Route handlers (`packages/server/src/routes/proposals.ts`):
  - All proposal endpoints from design doc Section 5
  - Transition endpoint with role enforcement
  - Work item creation endpoint
- Integration tests covering:
  - CRUD happy paths
  - Every valid status transition
  - Every invalid status transition (human trying AI-only transitions, AI trying human-only transitions)
  - Auto-transition on AI comment
  - Work item creation from accepted proposal
  - Rejection that proposal_id cannot be null when creating epics/tasks via implement endpoint
  - Comments appearing on proposal detail

**Verify**: All tests pass. Role enforcement is airtight — no way for AI to accept/reject, no way for anyone to skip statuses.

### Step 7 — API: Epics and Tasks CRUD

Epic and task management including subtasks and the task context JSON field.

- Epic service + routes:
  - CRUD operations
  - Task summary (count by status) included in epic detail
  - `proposal_id` FK populated when created via `implementProposal`
- Task service + routes:
  - CRUD operations
  - Subtask creation (`POST /tasks/:id/subtasks`) and listing
  - Task context JSON field (validate against context schema from shared package)
  - Filtering: status, priority, assignee, epic, type, search (basic LIKE for now — FTS comes in Step 9)
  - Sorting: priority, created_at, updated_at, due_date, sort_order
  - Pagination
  - `proposal_id` FK populated when created via `implementProposal`
- Integration tests covering:
  - CRUD for both entities
  - Subtask hierarchy (create, list, parent reference)
  - Task filtering combinations
  - Context JSON storage and retrieval
  - Pagination

**Verify**: All tests pass. Tasks can be filtered by multiple criteria simultaneously. Subtask hierarchy works correctly.

### Step 8 — API: Comments, Labels, Dependencies

Cross-cutting features that link to tasks and proposals.

- Comment service + routes:
  - Polymorphic parent (exactly one of `task_id` or `proposal_id` must be set — validate this)
  - Comment types from design doc (comment, progress_update, decision, question, handoff, review_note, design_discussion)
  - Metadata JSON validation per comment type
  - List, create, update, delete
- Label service + routes:
  - Project-scoped labels (CRUD)
  - Attach/detach labels to tasks
  - Unique name within project enforcement
- Task dependency service + routes:
  - Add/remove dependencies
  - Cycle detection (prevent circular dependencies — DFS/BFS in service layer)
  - `is_blocked` computed field: task has unresolved blocking dependencies (dependency target not in `done` status)
- Update task list endpoint to support `is_blocked` and `label` filters
- Integration tests covering:
  - Comment polymorphism (task comments vs proposal comments)
  - Comment type + metadata validation
  - Label CRUD and attach/detach
  - Dependency creation and cycle detection (test triangle cycle, self-reference, deep chain)
  - `is_blocked` filter accuracy

**Verify**: All tests pass. Cannot create circular dependencies. `is_blocked` correctly reflects dependency status.

### Step 9 — API: Search, Activity, Milestones, OpenAPI finalization

Remaining API endpoints and polish to complete the server package.

- FTS5 search:
  - Trigger-based sync for FTS tables (insert/update/delete triggers on tasks, comments, proposals)
  - Search endpoint (`GET /api/v1/search`) querying across proposals_fts, tasks_fts, comments_fts
  - Results with entity type, ID, title/excerpt, relevance ranking
  - Optional project_id and entity_type filters
- Activity log:
  - Event recording (create a utility that services call after mutations)
  - Field-level change tracking (diff old vs new values)
  - Activity endpoints: project-scoped feed, task-scoped history
  - Pagination, filtering by entity_type and actor
- Milestone service + routes (basic CRUD — not heavily used in Phase 1)
- Git ref stubs (table exists from migration, but only basic CRUD routes — full git integration is Phase 3)
- Review and finalize OpenAPI spec:
  - All endpoints documented
  - Response schemas match actual responses
  - Consistent error schemas
- API client generation script (`pnpm generate:api-client` in web package):
  - Uses `openapi-typescript` to generate types from the spec
  - Uses `openapi-fetch` for the runtime client

**Verify**: Full-text search returns relevant results for queries across entities. Activity log records mutations from previous steps' tests. OpenAPI spec is complete and valid. API client types generate without errors.

### Step 10 — Web UI: App shell, design system, routing

Set up the complete frontend infrastructure. After this step, the app renders with navigation and layout — but no data fetching yet.

- Tailwind CSS v4 configuration
- shadcn/ui setup (install CLI, configure, add core components: Button, Input, Card, Badge, Separator, Dropdown Menu, Dialog, Sheet, Tabs, Table, Textarea, Select, Label, Form, Toast)
- App shell components:
  - `AppLayout` — sidebar + header + main content area
  - `Sidebar` — collapsible, with navigation links (Proposals, Dashboard placeholder, Board placeholder, Tasks, Epics placeholder, Activity placeholder, Settings placeholder). Active-route highlighting.
  - `Header` — breadcrumbs, search placeholder (Cmd+K), user menu placeholder
- TanStack Router setup:
  - Route tree: `/projects`, `/projects/:projectId/proposals`, `/proposals/:proposalId`, `/projects/:projectId/tasks`, `/tasks/:taskId`
  - Layout routes (shell wraps all pages)
  - 404 fallback page
- TanStack Query provider
- Zustand store skeleton (sidebar collapse state, current project context)
- Dark mode as default (Tailwind dark class strategy), light mode toggle in header
- Placeholder pages for each route (just showing route name) so navigation works

**Verify**: `pnpm dev --filter web` starts. App renders with sidebar navigation. Clicking nav links routes correctly. Dark mode renders. Sidebar collapses/expands. No console errors.

### Step 11 — Web UI: Project and Proposal pages

The primary human workflow: see projects, create proposals, discuss with AI.

- API client integration:
  - Import generated types from Step 9's API client generation
  - TanStack Query hooks for all project and proposal endpoints
  - Configured with base URL from env/config
- Project list page (`/projects`):
  - Card grid showing projects with name, description, status badge, task/proposal counts
  - "New Project" dialog (name, description)
  - Click to enter project → navigates to proposals view
- Proposal list page (`/projects/:projectId/proposals`):
  - Status tabs: Open | Discussing | Accepted | Implemented | Rejected
  - Badge counts per status tab
  - Proposal cards showing title, description preview, comment count, created date
  - "New Proposal" button — opens form with title + markdown description editor
  - Click to open proposal detail
- Proposal detail page (`/proposals/:proposalId`):
  - Title (editable inline) + description (editable markdown)
  - Status badge
  - Action buttons: "Accept" / "Reject" (visible to humans, triggers transition)
  - Discussion thread:
    - Comments displayed chronologically
    - Visual distinction between human and AI comments (subtle icon or border color)
    - Comment type badges (design_discussion, question, decision)
    - Markdown rendering for comment bodies
  - Comment composer at bottom (markdown textarea + submit)
  - "Spawned Work" section (visible when status is `implemented`): linked epics and tasks as clickable cards
- Loading states (skeleton loaders), error states, empty states for all pages

**Verify**: `pnpm dev` (both server and web). Can create a project. Can create a proposal. Can view proposal detail. Can add comments. Can accept/reject a proposal. Status transitions work from the UI. Proposal list filters by status tab correctly.

### Step 12 — Web UI: Task list and task detail

Task management views for the human director to monitor AI work.

- TanStack Query hooks for task and epic endpoints
- Task list page (`/projects/:projectId/tasks`):
  - Table view with columns: title, status, priority, type, assignee, epic, effort, updated
  - Sortable columns (click header to sort)
  - Filter bar: status (multi-select), priority, type, assignee, epic (dropdown)
  - Search input (calls search API)
  - Clickable rows → task detail
  - Empty state when no tasks exist ("Tasks will appear here when proposals are implemented")
- Task detail page (`/tasks/:taskId`):
  - Title + description (editable markdown)
  - Metadata panel: status, priority, type, effort, assignee, due date (editable via dropdowns/selects)
  - Context section: relevant files (tag list), acceptance criteria (checklist display), implementation hints
  - Subtasks list with status badges and progress bar (N/total done)
  - Dependencies section: "Blocked by" and "Blocks" with task title links and status badges
  - Comments/Activity timeline (merged, chronological):
    - Typed comments rendered with appropriate icons (decision gets a gavel icon, progress_update gets a chart icon, etc.)
    - Handoff comments highlighted with summary, files changed, open questions
  - Comment composer with type selector dropdown
- Epic list page (`/projects/:projectId/epics`) — simpler:
  - List of epics with name, status, progress bar (tasks done/total)
  - Click to see epic detail (description + scoped task list)

**Verify**: `pnpm dev` (both server and web). Can browse tasks and epics. Task filters work. Task detail shows all metadata. Comments render with type-specific styling. Subtask progress bar computes correctly.

### Step 13 — MCP Server

MCP server with read and proposal tools. AI agents can discover work and engage with proposals.

- MCP server scaffold (`packages/mcp-server/src/index.ts`):
  - `@modelcontextprotocol/sdk` with stdio transport
  - HTTP client configured from `PM_API_URL` and `PM_API_TOKEN` env vars
  - Graceful error handling (API errors → MCP error responses)
- API client module (HTTP wrapper for calling the REST API)
- Read tools (from design doc Section 6):
  - `pm_list_projects` — list projects with optional status filter
  - `pm_list_tasks` — list tasks with rich filtering (status, priority, assignee, epic, type, is_blocked, search, sort, limit)
  - `pm_get_task` — full task detail including comments, deps, subtasks, context
  - `pm_search` — full-text search
- Proposal tools (from design doc Section 6):
  - `pm_list_proposals` — list proposals with optional status filter
  - `pm_get_proposal` — full proposal with discussion and linked work items
  - `pm_discuss_proposal` — add a comment, auto-transition open → discussing
- MCP resources:
  - `pm://projects` — list active projects
  - `pm://project/{id}/proposals` — active proposals needing AI engagement
- Integration tests:
  - Start a test API server, configure MCP server against it
  - Test each tool: correct parameters, correct responses, error cases
  - Test proposal discussion flow end-to-end

**Verify**: MCP server starts via `node packages/mcp-server/dist/index.js`. All tools return correct data. Proposal discussion tool creates comments and triggers status transition. Integration tests pass.

---

## Dependency DAG

```
depends_on:
  step_2: [step_1]
  step_3: [step_2]
  step_4: [step_3]
  step_5: [step_4]
  step_6: [step_5]
  step_7: [step_5]
  step_8: [step_6, step_7]
  step_9: [step_8]
  step_10: [step_1]
  step_11: [step_9, step_10]
  step_12: [step_11]
  step_13: [step_9]
```

### Parallelism notes

- **Steps 6 and 7** can run in parallel (proposals and epics/tasks are independent CRUD — both depend on projects from Step 5, but don't share service code).
- **Step 10** (web shell) can run in parallel with Steps 2–9 (it only needs the monorepo from Step 1). In practice the server pipeline is the longer path.
- **Steps 12 and 13** can run in parallel (web task pages and MCP server are independent — both consume the API but don't share code).

### Critical path

```
1 → 2 → 3 → 4 → 5 → 6 ┐
                    → 7 ┤→ 8 → 9 → 11 → 12 → done
                        │        ↘
                        │         13 ──→ done
1 → 10 ────────────────────→ 11
```

The longest path is: 1 → 2 → 3 → 4 → 5 → {6,7} → 8 → 9 → 11 → 12 (12 sequential steps, with 6/7 parallelizable).
