# High-Level Design: Human-AI Collaborative Project Management System

**Target audience**: Claude agents (design, implementation, testing)
**Created**: 2026-05-27
**Status**: Approved by human director (2026-05-27)

---

## 1. Vision

A project management system purpose-built for human-AI collaboration. Humans direct (set priorities, review work, make strategic decisions). AI agents execute (design, implement, test, report). The system treats AI agents as first-class participants with their own identity, autonomy model, and optimized interfaces.

**Core principle**: Two native interfaces with equal priority — a web UI for human directors, and an MCP server + REST API for AI agents. Neither is a second-class wrapper around the other; both consume the same API layer.

**Non-goals**: Enterprise scale, SaaS multi-tenancy, mobile apps, Gantt charts, time tracking invoicing. This is a focused tool for small teams (1-3 humans, multiple AI agents) working locally or on a shared LAN.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Clients                                  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │   Web UI      │  │  MCP Server  │  │  REST API clients │  │
│  │  (React SPA)  │  │  (stdio)     │  │  (curl, scripts)  │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘  │
│         │                 │                    │              │
└─────────┼─────────────────┼────────────────────┼─────────────┘
          │                 │                    │
          ▼                 ▼                    ▼
    ┌─────────────────────────────────────────────────┐
    │              REST API (Hono)                     │
    │         OpenAPI-documented endpoints             │
    │                                                  │
    │  ┌────────────┐ ┌──────────┐ ┌───────────────┐  │
    │  │   Auth     │ │ WebSocket│ │  Middleware    │  │
    │  │  (tokens + │ │  (SSE)   │ │  (validation, │  │
    │  │  sessions) │ │          │ │   logging)    │  │
    │  └────────────┘ └──────────┘ └───────────────┘  │
    │                                                  │
    │  ┌──────────────────────────────────────────┐   │
    │  │         Service Layer                     │   │
    │  │  (business logic, workflow engine,        │   │
    │  │   event emission, authorization)          │   │
    │  └──────────────────┬───────────────────────┘   │
    │                     │                            │
    │  ┌──────────────────▼───────────────────────┐   │
    │  │         Data Access Layer (Drizzle ORM)   │   │
    │  └──────────────────┬───────────────────────┘   │
    │                     │                            │
    └─────────────────────┼────────────────────────────┘
                          │
                    ┌─────▼─────┐
                    │  SQLite   │
                    │ (single   │
                    │  file DB) │
                    └───────────┘
```

**Single process model**: The API server serves both the REST API and the pre-built React SPA as static assets. One binary/process to run, one port to expose. The MCP server is a separate lightweight process that communicates with the API server over HTTP (localhost) — it exists as a separate process because MCP uses stdio transport and is configured independently in Claude's MCP settings.

**Event bus**: Internal pub/sub for decoupling. When a task status changes, the service layer emits an event. Listeners handle: activity log writes, WebSocket/SSE broadcasts, future automation triggers. This is in-process (no external message broker) — an EventEmitter with typed events.

---

## 3. Technology Stack

### Backend
| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | **Node.js 22 LTS** | Cross-platform, ubiquitous, excellent TypeScript support |
| API Framework | **Hono** | Fast, lightweight, excellent TypeScript types, built-in OpenAPI via `@hono/zod-openapi`, works on Node/Bun/Deno |
| Validation | **Zod** | Schema-first validation, TypeScript type inference, OpenAPI integration |
| ORM | **Drizzle ORM** | Type-safe, lightweight, excellent SQLite support, SQL-like API (not abstracted away), migration tooling |
| Database | **SQLite** via `better-sqlite3` | Zero-config, file-based, single-file backup, perfect for local/small-team use. Synchronous driver avoids async complexity |
| Auth | **Custom token-based** | Simple API tokens for agents, session cookies for web UI. No OAuth complexity needed for local use |
| Real-time | **Server-Sent Events (SSE)** | Simpler than WebSocket, sufficient for server→client push (status updates, activity feed). Works through proxies. |
| Password hashing | **bcrypt** via `bcryptjs` | Pure JS, cross-platform |

### Frontend
| Component | Choice | Rationale |
|-----------|--------|-----------|
| Framework | **React 19** | Largest ecosystem, excellent tooling, server components for future |
| Build tool | **Vite 6** | Fast HMR, excellent DX, handles both dev and production builds |
| Routing | **TanStack Router** | Type-safe routes, file-based routing option, built-in search params |
| Data fetching | **TanStack Query** | Cache management, background refetching, optimistic updates, SSE integration |
| Styling | **Tailwind CSS v4** | Utility-first, no context-switching, excellent with component libraries |
| Components | **shadcn/ui** | Copy-paste components (not a dependency), accessible, customizable, professional look |
| State | **Zustand** | Lightweight, no boilerplate, TypeScript-native |
| DnD | **@dnd-kit** | Accessible drag-and-drop for Kanban board |
| Markdown | **@uiw/react-markdown-preview** | Render markdown descriptions/comments |
| Forms | **React Hook Form + Zod** | Type-safe forms with Zod schema reuse from shared package |

### MCP Server
| Component | Choice | Rationale |
|-----------|--------|-----------|
| SDK | **@modelcontextprotocol/sdk** | Official MCP SDK |
| Transport | **stdio** | Standard for local MCP servers |
| HTTP client | **Generated from OpenAPI spec** | Type-safe API calls to the main server |

### Monorepo & Tooling
| Component | Choice | Rationale |
|-----------|--------|-----------|
| Package manager | **pnpm** | Efficient, strict, excellent workspace support, cross-platform |
| Monorepo orchestrator | **Turborepo** | Build caching, task dependency graph, pnpm-native |
| Language | **TypeScript 5.x** throughout | Type safety end-to-end, shared types between packages |
| Testing | **Vitest** (unit/integration), **Playwright** (E2E) | Fast, TypeScript-native, compatible APIs |
| Linting | **ESLint 9** (flat config) + **Prettier** | Standard tooling |
| API client gen | **openapi-typescript** + **openapi-fetch** | Type-safe API client generated from OpenAPI spec |

### Project Structure

```
project-management/
├── packages/
│   ├── server/                 # Hono API server
│   │   ├── src/
│   │   │   ├── routes/         # Route handlers (OpenAPI-defined)
│   │   │   ├── services/       # Business logic layer
│   │   │   ├── db/
│   │   │   │   ├── schema.ts   # Drizzle schema definitions
│   │   │   │   └── migrations/ # SQL migrations
│   │   │   ├── middleware/     # Auth, logging, error handling
│   │   │   ├── events/        # Event bus and listeners
│   │   │   └── index.ts       # Server entry point
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── web/                    # React SPA
│   │   ├── src/
│   │   │   ├── components/    # UI components
│   │   │   ├── pages/         # Route pages
│   │   │   ├── hooks/         # Custom React hooks
│   │   │   ├── lib/           # API client, utilities
│   │   │   └── stores/        # Zustand stores
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── shared/                 # Shared types & schemas
│   │   ├── src/
│   │   │   ├── schemas/       # Zod schemas (source of truth)
│   │   │   ├── types/         # TypeScript types derived from schemas
│   │   │   └── constants/     # Enums, status definitions, etc.
│   │   └── package.json
│   │
│   └── mcp-server/             # MCP server for Claude
│       ├── src/
│       │   ├── tools/         # MCP tool definitions
│       │   ├── resources/     # MCP resource definitions
│       │   └── index.ts       # MCP server entry point
│       ├── tests/
│       └── package.json
│
├── tests/
│   └── e2e/                   # Playwright E2E tests
│
├── package.json               # Root workspace config
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json         # Shared TypeScript config
└── CLAUDE.md                  # Agent instructions
```

---

## 4. Data Model

All IDs are ULIDs (sortable, unique, no coordination needed). Timestamps are ISO 8601 strings stored as TEXT in SQLite. JSON fields use SQLite's JSON functions for queries where needed.

### Entity Relationship Diagram

```
workspace  1──* project
project    1──* proposal
project    1──* epic
project    1──* task
project    1──* label
project    1──* milestone
proposal   1──* epic          (proposal spawns epics)
proposal   1──* task          (proposal spawns standalone tasks)
proposal   1──* comment       (design discussion)
epic       1──* task
task       1──* task          (parent → subtasks)
task       1──* comment
task       *──* label         (via task_labels)
task       *──* task          (via task_dependencies)
task       1──* git_ref
activity_log ──> all entities (polymorphic via entity_type + entity_id)
user       1──* proposal      (created_by — always human)
user       1──* task          (assignee)
user       1──* comment       (author)
user       1──* activity_log  (actor)
milestone  1──* epic          (target milestone)
```

### Design Process: Proposals

The **Proposal** is the primary entry point for all work in the system. Human directors never create epics or tasks directly — they create proposals.

**Flow:**
1. Human writes a proposal (vague idea, high-level description)
2. AI agent engages via comments (clarifying questions, design approaches, tradeoffs)
3. Human and AI iterate until the design is agreed upon
4. Human explicitly moves proposal to `accepted` status (approval gate — AI cannot skip this)
5. AI creates epics and/or tasks from the accepted proposal, linking them back
6. Proposal status auto-transitions to `implemented` when work items are created

**Key invariants:**
- Only humans can create proposals
- Only humans can transition a proposal to `accepted`
- AI agents can transition proposals to `discussing` (by engaging) and to `implemented` (by creating work items from an `accepted` proposal)
- A proposal can spawn 0..N epics and 0..N standalone tasks
- A rejected proposal is preserved for historical context (never deleted)

### Table Definitions

#### `workspaces`
Single workspace for now (multi-workspace is YAGNI for local use), but the schema supports it for forward compatibility.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| name | TEXT | Required |
| description | TEXT | Optional |
| settings | TEXT (JSON) | Default workflow, AI autonomy defaults |
| created_at | TEXT (ISO 8601) | |
| updated_at | TEXT (ISO 8601) | |

#### `users`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| username | TEXT | Unique, used for login and @mentions |
| display_name | TEXT | Human-readable name |
| email | TEXT | Optional |
| role | TEXT | `admin` or `member` |
| type | TEXT | `human` or `ai_agent` |
| avatar_url | TEXT | Optional, for UI display |
| password_hash | TEXT | Nullable (AI agents don't have passwords) |
| api_token_hash | TEXT | For API/MCP authentication |
| is_active | INTEGER (bool) | Soft disable |
| created_at | TEXT (ISO 8601) | |
| updated_at | TEXT (ISO 8601) | |

#### `projects`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| workspace_id | TEXT | FK → workspaces |
| name | TEXT | Required |
| slug | TEXT | URL-friendly, unique within workspace |
| description | TEXT | Markdown |
| status | TEXT | `active`, `paused`, `archived`, `completed` |
| git_repo_url | TEXT | Optional, for linking to a git repository |
| settings | TEXT (JSON) | AI autonomy level, custom workflow, etc. |
| sort_order | INTEGER | For manual ordering in UI |
| created_at | TEXT (ISO 8601) | |
| updated_at | TEXT (ISO 8601) | |
| created_by | TEXT | FK → users |

**Project settings JSON structure:**
```json
{
  "ai_autonomy": {
    "can_self_assign": true,
    "can_create_subtasks": true,
    "can_create_tasks": false,
    "can_change_priority": false,
    "can_close_epics": false,
    "max_concurrent_tasks": 3
  },
  "workflow": {
    "statuses": ["backlog", "ready", "in_progress", "in_review", "done", "cancelled"]
  },
  "git": {
    "branch_prefix": "feat/",
    "auto_link_branches": true
  }
}
```

#### `proposals`

The human director's primary interface for creating work. Intentionally lightweight — no priority, no assignee, no effort. Those concepts belong on the work items the AI creates from it.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| project_id | TEXT | FK → projects, nullable (can be pre-project or cross-project) |
| title | TEXT | Short description of the idea |
| description | TEXT | Markdown — the "hand-wave," as detailed or vague as the human wants |
| status | TEXT | `open`, `discussing`, `accepted`, `implemented`, `rejected` |
| created_by | TEXT | FK → users (always a human) |
| resolved_by | TEXT | FK → users, nullable (who accepted/rejected) |
| resolved_at | TEXT (ISO 8601) | When accepted or rejected |
| created_at | TEXT (ISO 8601) | |
| updated_at | TEXT (ISO 8601) | |

**Status transitions:**
```
open → discussing     (AI engages with the proposal)
discussing → accepted (human approves the design — HUMAN ONLY)
discussing → rejected (human rejects the idea — HUMAN ONLY)
open → rejected       (human rejects without discussion — HUMAN ONLY)
accepted → implemented (AI creates work items from it)
```

#### `epics`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| project_id | TEXT | FK → projects |
| proposal_id | TEXT | FK → proposals, nullable (the proposal that spawned this epic) |
| milestone_id | TEXT | FK → milestones, nullable |
| name | TEXT | Required |
| description | TEXT | Markdown — detailed spec, acceptance criteria |
| status | TEXT | `draft`, `active`, `completed`, `cancelled` |
| priority | TEXT | `critical`, `high`, `medium`, `low` |
| target_date | TEXT | Optional deadline |
| sort_order | INTEGER | For manual ordering |
| created_at | TEXT (ISO 8601) | |
| updated_at | TEXT (ISO 8601) | |
| created_by | TEXT | FK → users |

#### `tasks`

The primary work unit. Designed to support both human-created high-level tasks and AI-created subtasks.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| project_id | TEXT | FK → projects |
| proposal_id | TEXT | FK → proposals, nullable (the proposal that spawned this task, if not via an epic) |
| epic_id | TEXT | FK → epics, nullable |
| parent_task_id | TEXT | FK → tasks, nullable (for subtasks) |
| title | TEXT | Short, imperative ("Add user authentication") |
| description | TEXT | Markdown — detailed spec, context, acceptance criteria |
| status | TEXT | From project workflow. Default: `backlog` |
| priority | TEXT | `critical`, `high`, `medium`, `low` |
| type | TEXT | `feature`, `bug`, `chore`, `spike`, `design`, `research` |
| assignee_id | TEXT | FK → users, nullable |
| reporter_id | TEXT | FK → users (who created it) |
| estimated_effort | TEXT | `xs`, `s`, `m`, `l`, `xl` — relative sizing |
| due_date | TEXT | Optional deadline |
| sort_order | INTEGER | Within its container (epic, or project backlog) |
| context | TEXT (JSON) | AI context — see structure below |
| git_branch | TEXT | Primary branch for this task |
| created_at | TEXT (ISO 8601) | |
| updated_at | TEXT (ISO 8601) | |
| started_at | TEXT (ISO 8601) | When status first moved to in_progress |
| completed_at | TEXT (ISO 8601) | When status moved to done |

**Task context JSON structure** (AI-optimized metadata):
```json
{
  "relevant_files": ["src/auth/middleware.ts", "src/routes/login.ts"],
  "codebase_areas": ["authentication", "middleware"],
  "acceptance_criteria": [
    "All API endpoints require valid token",
    "Expired tokens return 401"
  ],
  "design_references": ["docs/design/auth-design.md"],
  "notes": "Must be compatible with the existing session middleware",
  "implementation_hints": "Use the existing validateToken utility in src/utils/auth.ts"
}
```

#### `task_dependencies`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| task_id | TEXT | FK → tasks (the blocked task) |
| depends_on_task_id | TEXT | FK → tasks (the blocking task) |
| dependency_type | TEXT | `blocks`, `relates_to` |
| created_at | TEXT (ISO 8601) | |

Constraint: No circular dependencies (enforced in service layer).

#### `labels`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| project_id | TEXT | FK → projects |
| name | TEXT | Unique within project |
| color | TEXT | Hex color code |
| description | TEXT | Optional |

#### `task_labels`

| Column | Type | Notes |
|--------|------|-------|
| task_id | TEXT | FK → tasks |
| label_id | TEXT | FK → labels |
| PRIMARY KEY | (task_id, label_id) | Composite |

#### `comments`

Comments are polymorphic — they can belong to a task or a proposal. Exactly one of `task_id` or `proposal_id` must be set.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| task_id | TEXT | FK → tasks, nullable |
| proposal_id | TEXT | FK → proposals, nullable |
| author_id | TEXT | FK → users |
| body | TEXT | Markdown |
| comment_type | TEXT | `comment`, `progress_update`, `decision`, `question`, `handoff`, `review_note`, `design_discussion` |
| metadata | TEXT (JSON) | Structured data for typed comments (see below) |
| created_at | TEXT (ISO 8601) | |
| updated_at | TEXT (ISO 8601) | |

**Comment metadata by type:**
```json
// progress_update
{ "completion_pct": 60, "files_changed": ["src/foo.ts"], "summary": "..." }

// decision
{ "decision": "Use JWT over session tokens", "rationale": "...", "alternatives_considered": ["session tokens", "OAuth"] }

// handoff
{ "summary": "...", "files_changed": ["..."], "open_questions": ["..."], "test_results": "all passing" }
```

#### `activity_log`

Append-only audit trail. Every mutation generates an activity log entry.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| entity_type | TEXT | `project`, `proposal`, `epic`, `task`, `comment` |
| entity_id | TEXT | ID of the affected entity |
| project_id | TEXT | FK → projects (denormalized for efficient project-scoped queries) |
| actor_id | TEXT | FK → users |
| action | TEXT | `created`, `updated`, `status_changed`, `assigned`, `commented`, `dependency_added`, etc. |
| changes | TEXT (JSON) | Field-level diff: `{"status": {"from": "ready", "to": "in_progress"}}` |
| created_at | TEXT (ISO 8601) | |

#### `git_refs`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| task_id | TEXT | FK → tasks |
| ref_type | TEXT | `branch`, `commit`, `pull_request` |
| ref_value | TEXT | Branch name, commit SHA, or PR number |
| url | TEXT | Optional URL (e.g., GitHub PR link) |
| title | TEXT | Optional (PR title, commit message first line) |
| status | TEXT | For PRs: `open`, `merged`, `closed`. For commits: null |
| metadata | TEXT (JSON) | Additional data |
| created_at | TEXT (ISO 8601) | |

#### `milestones`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | PK |
| project_id | TEXT | FK → projects |
| name | TEXT | e.g., "v1.0", "Beta Launch" |
| description | TEXT | Markdown |
| target_date | TEXT | |
| status | TEXT | `open`, `closed` |
| sort_order | INTEGER | |
| created_at | TEXT (ISO 8601) | |
| updated_at | TEXT (ISO 8601) | |

### Indexes

```sql
-- Proposal queries
CREATE INDEX idx_proposals_project_status ON proposals(project_id, status);
CREATE INDEX idx_proposals_created_by ON proposals(created_by);

-- Task queries (the most frequent operation)
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX idx_tasks_project_epic ON tasks(project_id, epic_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_priority ON tasks(project_id, priority);
CREATE INDEX idx_tasks_status_priority ON tasks(project_id, status, priority);

-- Activity log (high volume reads)
CREATE INDEX idx_activity_project ON activity_log(project_id, created_at DESC);
CREATE INDEX idx_activity_entity ON activity_log(entity_type, entity_id, created_at DESC);

-- Git refs
CREATE INDEX idx_git_refs_task ON git_refs(task_id);
CREATE INDEX idx_git_refs_branch ON git_refs(ref_type, ref_value);

-- Comments
CREATE INDEX idx_comments_task ON comments(task_id, created_at);
CREATE INDEX idx_comments_proposal ON comments(proposal_id, created_at);

-- Dependencies
CREATE INDEX idx_deps_task ON task_dependencies(task_id);
CREATE INDEX idx_deps_depends_on ON task_dependencies(depends_on_task_id);

-- Full-text search (SQLite FTS5)
CREATE VIRTUAL TABLE proposals_fts USING fts5(title, description, content=proposals, content_rowid=rowid);
CREATE VIRTUAL TABLE tasks_fts USING fts5(title, description, content=tasks, content_rowid=rowid);
CREATE VIRTUAL TABLE comments_fts USING fts5(body, content=comments, content_rowid=rowid);
```

---

## 5. REST API Design

Base URL: `http://localhost:3000/api/v1`

All responses follow a consistent envelope:
```json
// Success (single entity)
{ "data": { ... } }

// Success (list)
{ "data": [ ... ], "pagination": { "total": 42, "page": 1, "per_page": 50 } }

// Error
{ "error": { "code": "NOT_FOUND", "message": "Task not found" } }
```

### Authentication

Two auth mechanisms:
1. **API Token** (header): `Authorization: Bearer <token>` — for AI agents and scripts
2. **Session cookie**: `pm_session=<token>` — for web UI, set after login

### Endpoints

#### Projects
| Method | Path | Description |
|--------|------|-------------|
| GET | /projects | List projects (filter: status) |
| POST | /projects | Create project |
| GET | /projects/:id | Get project details |
| PATCH | /projects/:id | Update project |
| DELETE | /projects/:id | Archive project (soft delete) |
| GET | /projects/:id/stats | Project statistics (task counts by status, etc.) |

#### Proposals
| Method | Path | Description |
|--------|------|-------------|
| GET | /projects/:projectId/proposals | List proposals (filter: status) |
| POST | /projects/:projectId/proposals | Create proposal (human only) |
| GET | /proposals/:id | Get proposal with comments and linked work items |
| PATCH | /proposals/:id | Update proposal (title, description) |
| POST | /proposals/:id/transitions | Change proposal status (with role enforcement) |
| GET | /proposals/:id/comments | List discussion comments |
| POST | /proposals/:id/comments | Add comment to proposal discussion |
| GET | /proposals/:id/work-items | List epics and tasks spawned from this proposal |

**POST /proposals/:id/transitions** body:
```json
{
  "to_status": "accepted",
  "comment": "Design looks good, proceed with implementation"  // optional
}
```
Enforces role constraints: only humans can transition to `accepted` or `rejected`. AI can transition `open` → `discussing` and `accepted` → `implemented`.

#### Epics
| Method | Path | Description |
|--------|------|-------------|
| GET | /projects/:projectId/epics | List epics (filter: status, milestone) |
| POST | /projects/:projectId/epics | Create epic |
| GET | /epics/:id | Get epic with task summary |
| PATCH | /epics/:id | Update epic |
| DELETE | /epics/:id | Archive epic |

#### Tasks
| Method | Path | Description |
|--------|------|-------------|
| GET | /projects/:projectId/tasks | List tasks (rich filtering — see below) |
| POST | /projects/:projectId/tasks | Create task |
| GET | /tasks/:id | Get full task (includes comments, deps, git refs) |
| PATCH | /tasks/:id | Update task fields |
| DELETE | /tasks/:id | Archive task |
| POST | /tasks/:id/subtasks | Create subtask |
| GET | /tasks/:id/subtasks | List subtasks |

**Task list query parameters:**
- `status` — filter by status (comma-separated for multiple)
- `priority` — filter by priority
- `assignee` — filter by assignee ID (or `unassigned`, `me`)
- `epic` — filter by epic ID (or `none` for tasks without epic)
- `label` — filter by label name
- `type` — filter by task type
- `search` — full-text search
- `has_dependencies` — `true`/`false`
- `is_blocked` — `true`/`false` (has unresolved blocking deps)
- `sort` — `priority`, `created_at`, `updated_at`, `sort_order`, `due_date`
- `order` — `asc`, `desc`
- `page`, `per_page` — pagination

#### Task Workflow
| Method | Path | Description |
|--------|------|-------------|
| POST | /tasks/:id/transitions | Change task status (validates workflow rules) |
| POST | /tasks/pick-next | AI: find and self-assign highest priority ready task |

**POST /tasks/:id/transitions** body:
```json
{
  "to_status": "in_progress",
  "comment": "Starting implementation"   // optional
}
```

**POST /tasks/pick-next** body:
```json
{
  "project_id": "...",           // optional, scope to project
  "task_types": ["feature", "bug"],  // optional, filter types
  "max_effort": "m"             // optional, effort ceiling
}
```
Returns the claimed task, or 404 if nothing available. Atomically sets assignee + status to prevent race conditions between multiple AI agents.

#### Dependencies
| Method | Path | Description |
|--------|------|-------------|
| POST | /tasks/:id/dependencies | Add dependency |
| DELETE | /tasks/:id/dependencies/:depId | Remove dependency |

#### Comments
| Method | Path | Description |
|--------|------|-------------|
| GET | /tasks/:taskId/comments | List comments |
| POST | /tasks/:taskId/comments | Add comment |
| PATCH | /comments/:id | Edit comment |
| DELETE | /comments/:id | Delete comment |

#### Labels
| Method | Path | Description |
|--------|------|-------------|
| GET | /projects/:projectId/labels | List labels |
| POST | /projects/:projectId/labels | Create label |
| PATCH | /labels/:id | Update label |
| DELETE | /labels/:id | Delete label |
| POST | /tasks/:id/labels | Attach label to task |
| DELETE | /tasks/:id/labels/:labelId | Remove label from task |

#### Git Refs
| Method | Path | Description |
|--------|------|-------------|
| GET | /tasks/:taskId/git-refs | List git refs for task |
| POST | /tasks/:taskId/git-refs | Add git ref |
| PATCH | /git-refs/:id | Update git ref (e.g., PR status) |
| DELETE | /git-refs/:id | Remove git ref |

#### Activity
| Method | Path | Description |
|--------|------|-------------|
| GET | /projects/:projectId/activity | Project activity feed (paginated, filterable by entity_type, actor) |
| GET | /tasks/:taskId/activity | Task activity history |

#### Milestones
| Method | Path | Description |
|--------|------|-------------|
| GET | /projects/:projectId/milestones | List milestones |
| POST | /projects/:projectId/milestones | Create milestone |
| PATCH | /milestones/:id | Update milestone |
| DELETE | /milestones/:id | Delete milestone |

#### Users & Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | /auth/login | Login (returns session cookie) |
| POST | /auth/logout | Logout (clears session) |
| GET | /auth/me | Get current user |
| GET | /users | List users |
| POST | /users | Create user (admin) |
| PATCH | /users/:id | Update user |
| POST | /users/:id/rotate-token | Regenerate API token |

#### Search
| Method | Path | Description |
|--------|------|-------------|
| GET | /search | Full-text search across tasks and comments. Params: `q`, `project_id`, `entity_type` |

#### Events (SSE)
| Method | Path | Description |
|--------|------|-------------|
| GET | /events | SSE stream of real-time events (task updates, comments, status changes). Params: `project_id` to scope |

**SSE event format:**
```
event: task.updated
data: {"entity_type": "task", "entity_id": "...", "action": "status_changed", "changes": {"status": {"from": "ready", "to": "in_progress"}}, "actor": {"id": "...", "name": "claude-agent-1"}, "timestamp": "..."}
```

---

## 6. MCP Server Design

The MCP server is a separate process that communicates with the API server over HTTP (localhost). It translates between MCP protocol (stdio/JSON-RPC) and the REST API.

### Configuration

Claude's MCP config (`claude_desktop_config.json` or `.claude/settings.json`):
```json
{
  "mcpServers": {
    "project-management": {
      "command": "node",
      "args": ["path/to/packages/mcp-server/dist/index.js"],
      "env": {
        "PM_API_URL": "http://localhost:3000",
        "PM_API_TOKEN": "<agent-api-token>"
      }
    }
  }
}
```

### MCP Tools

Tools are designed as high-level workflow operations, not raw CRUD. Each tool name follows `pm_*` namespace convention.

#### Proposal Operations (Design Process)

These tools support the proposal→design→execution workflow. Proposals are the AI agent's primary entry point for understanding what the human director wants.

**`pm_list_proposals`**
List proposals, typically filtered to find ones needing AI engagement.
```
Parameters:
  - project_id?: string
  - status?: "open" | "discussing" | "accepted" | "implemented" | "rejected"
Returns: Array of {id, project_id, title, description, status, created_by, comment_count, created_at}
```

**`pm_get_proposal`**
Get full proposal details including the design discussion and any linked work items.
```
Parameters:
  - proposal_id: string
Returns: Proposal with:
  - All fields
  - comments (full design discussion, chronological)
  - linked_work_items: {epics: [...], tasks: [...]} (work created from this proposal)
```

**`pm_discuss_proposal`**
Engage with a proposal — ask clarifying questions, suggest approaches, present tradeoffs. Automatically transitions `open` → `discussing` on first AI comment.
```
Parameters:
  - proposal_id: string
  - body: string (markdown — the AI's design input, questions, or suggestions)
  - comment_type?: "design_discussion" | "question" | "decision" (default: design_discussion)
Returns: Created comment. Proposal status updated to `discussing` if it was `open`.
```

**`pm_implement_proposal`**
Create epics and/or tasks from an accepted proposal. This is how design becomes execution. Can only be called on proposals with status `accepted`. Transitions proposal to `implemented`.
```
Parameters:
  - proposal_id: string
  - epics?: Array<{
      name: string,
      description: string,
      priority?: string,
      tasks?: Array<{title, description, priority?, type?, estimated_effort?, context?}>
    }>
  - tasks?: Array<{
      title: string,
      description?: string,
      priority?: string,
      type?: string,
      estimated_effort?: string,
      context?: object
    }>
  - summary?: string (comment explaining the implementation plan)
Returns: {epics: [...created epics with tasks...], tasks: [...created standalone tasks...]}
```

#### Read Operations

**`pm_list_projects`**
List all projects with optional status filter.
```
Parameters:
  - status?: "active" | "paused" | "archived" | "completed"
Returns: Array of {id, name, slug, status, description, task_counts: {backlog, ready, in_progress, in_review, done}}
```

**`pm_get_project`**
Get project details including settings, recent activity, and epic summary.
```
Parameters:
  - project_id: string
Returns: Full project object with epics summary and task counts
```

**`pm_list_epics`**
List epics in a project.
```
Parameters:
  - project_id: string
  - status?: "draft" | "active" | "completed" | "cancelled"
Returns: Array of epics with task progress (done/total counts)
```

**`pm_get_epic`**
Get epic details with all tasks.
```
Parameters:
  - epic_id: string
Returns: Epic with full task list grouped by status
```

**`pm_list_tasks`**
Query tasks with rich filtering. This is the primary tool for understanding what work exists.
```
Parameters:
  - project_id?: string
  - epic_id?: string
  - status?: string (comma-separated)
  - priority?: string (comma-separated)
  - assignee?: string | "unassigned" | "me"
  - type?: string (comma-separated)
  - is_blocked?: boolean
  - search?: string
  - sort?: "priority" | "created_at" | "updated_at" | "due_date"
  - limit?: number (default 50)
Returns: Array of task summaries
```

**`pm_get_task`**
Get full task details including comments, dependencies, git refs, and context. This is what an AI agent reads before starting work on a task.
```
Parameters:
  - task_id: string
Returns: Complete task with:
  - All fields
  - comments (recent, chronological)
  - dependencies (blocking and blocked_by with status)
  - subtasks
  - git_refs
  - context object
  - activity log (recent)
```

**`pm_search`**
Full-text search across proposals, tasks, and comments.
```
Parameters:
  - query: string
  - project_id?: string
  - entity_type?: "proposal" | "task" | "comment"
  - limit?: number (default 20)
Returns: Array of {entity_type, entity_id, title/excerpt, relevance_score}
```

#### Workflow Operations

**`pm_pick_next_task`**
Find and atomically self-assign the highest priority task that is ready for work (status=ready, not blocked, not assigned). This is the primary tool for an AI agent to get work.
```
Parameters:
  - project_id?: string
  - task_types?: string[] (filter by type)
  - max_effort?: "xs" | "s" | "m" | "l" | "xl"
Returns: The claimed task (full details), or null if nothing available
```

**`pm_start_task`**
Claim a specific task and begin work. Sets status to `in_progress`, assigns to self, records `started_at`.
```
Parameters:
  - task_id: string
  - comment?: string (optional note about approach)
Returns: Updated task
```

**`pm_complete_task`**
Mark a task as done with a structured handoff.
```
Parameters:
  - task_id: string
  - summary: string (what was done)
  - files_changed?: string[] (list of modified files)
  - open_questions?: string[] (anything needing human attention)
  - test_results?: string (summary of test outcomes)
Returns: Updated task
```

**`pm_request_review`**
Move task to `in_review` status with review context for the human director.
```
Parameters:
  - task_id: string
  - summary: string
  - review_notes?: string (what to focus on during review)
  - files_changed?: string[]
Returns: Updated task
```

**`pm_block_task`**
Mark a task as blocked with a reason.
```
Parameters:
  - task_id: string
  - reason: string
  - blocked_by_task_id?: string (link to blocking task)
Returns: Updated task
```

#### Creation & Mutation

**`pm_create_task`**
Create a new task. AI agents use this to break down work or identify needed tasks.
```
Parameters:
  - project_id: string
  - title: string
  - description?: string (markdown)
  - epic_id?: string
  - parent_task_id?: string (create as subtask)
  - priority?: "critical" | "high" | "medium" | "low" (default: medium)
  - type?: "feature" | "bug" | "chore" | "spike" | "design" | "research" (default: feature)
  - estimated_effort?: "xs" | "s" | "m" | "l" | "xl"
  - context?: { relevant_files?, acceptance_criteria?, notes?, implementation_hints? }
  - depends_on?: string[] (task IDs this depends on)
Returns: Created task
```

**`pm_update_task`**
Update any mutable task fields.
```
Parameters:
  - task_id: string
  - title?: string
  - description?: string
  - priority?: string
  - type?: string
  - estimated_effort?: string
  - context?: object (merged with existing)
  - due_date?: string
Returns: Updated task
```

**`pm_add_comment`**
Add a comment to a task. Supports typed comments for structured communication.
```
Parameters:
  - task_id: string
  - body: string (markdown)
  - comment_type?: "comment" | "progress_update" | "decision" | "question" (default: comment)
  - metadata?: object (structured data for typed comments)
Returns: Created comment
```

**`pm_log_decision`**
Record a design decision with rationale. Creates a `decision` type comment with structured metadata.
```
Parameters:
  - task_id: string
  - decision: string (what was decided)
  - rationale: string (why)
  - alternatives_considered?: string[] (what else was considered)
Returns: Created comment
```

**`pm_report_progress`**
Post a structured progress update.
```
Parameters:
  - task_id: string
  - summary: string
  - completion_pct?: number (0-100)
  - files_changed?: string[]
  - blockers?: string[]
Returns: Created comment
```

#### Context & Git

**`pm_set_task_context`**
Set or update the AI context on a task.
```
Parameters:
  - task_id: string
  - relevant_files?: string[]
  - acceptance_criteria?: string[]
  - notes?: string
  - implementation_hints?: string
  - design_references?: string[]
Returns: Updated task
```

**`pm_link_git_ref`**
Link a git branch, commit, or PR to a task.
```
Parameters:
  - task_id: string
  - ref_type: "branch" | "commit" | "pull_request"
  - ref_value: string (branch name, SHA, or PR number)
  - url?: string
  - title?: string
Returns: Created git ref
```

### MCP Resources

Resources provide read-only context that Claude can reference.

| URI Pattern | Description |
|-------------|-------------|
| `pm://projects` | List of all active projects |
| `pm://project/{id}` | Project details with task summary |
| `pm://project/{id}/board` | Kanban view: tasks grouped by status |
| `pm://project/{id}/proposals` | Active proposals needing AI engagement |
| `pm://proposal/{id}` | Full proposal with design discussion |
| `pm://task/{id}` | Full task details with context |
| `pm://activity/recent` | Recent activity across all projects |

---

## 7. Frontend Design

### Page Structure

```
App Shell
├── Sidebar (collapsible)
│   ├── Workspace name
│   ├── Project switcher
│   ├── Navigation
│   │   ├── Proposals (primary human entry point)
│   │   ├── Dashboard
│   │   ├── Board (Kanban)
│   │   ├── Tasks (List view)
│   │   ├── Epics
│   │   ├── Milestones
│   │   └── Activity
│   └── Settings
├── Header
│   ├── Breadcrumbs
│   ├── Search (Cmd+K)
│   └── User menu
└── Main Content Area
    └── (page-specific content)
```

### Key Views

#### Proposals (primary human entry point)
- List view with status tabs: Open | Discussing | Accepted | Implemented | Rejected
- "New Proposal" button prominently placed — this is how humans create work
- Create form: just title + description (markdown editor). Intentionally minimal.
- Proposal detail view:
  - Title + description (editable by human)
  - Status badge with transition buttons (Accept / Reject — human only)
  - Design discussion thread (comments between human and AI, chronological)
  - Comment composer for the human to reply
  - "Spawned Work" section: linked epics and tasks (visible after `implemented`)
  - Activity timeline (status changes, who engaged when)
- Badge on sidebar showing count of proposals in `open` or `discussing` status

#### Dashboard
- Project health summary (task counts by status as bar/donut chart)
- Recent activity feed (who did what, when)
- My tasks (for the current user)
- Blocked tasks (attention needed)
- AI agent activity (what are agents working on right now?)

#### Board (Kanban)
- Columns = statuses from workflow
- Cards = tasks (show title, priority badge, assignee avatar, type icon, labels)
- Drag-and-drop between columns (status transition)
- Swimlanes by epic (optional)
- Filter bar (assignee, priority, type, label, search)
- Quick-add task (inline at bottom of any column)

#### Task List
- Table view with sortable columns
- Bulk selection + actions (assign, change status, change priority)
- Inline editing for quick updates
- Same filter bar as Board
- Grouping options (by epic, by assignee, by priority)

#### Task Detail (slide-over panel or dedicated page)
- Title, description (editable markdown)
- Status, priority, type, effort, assignee, due date (editable fields)
- Context section (relevant files, acceptance criteria — editable)
- Subtasks list (with progress bar)
- Dependencies (blocking / blocked by — with links)
- Git refs (branches, commits, PRs — with links)
- Comments / Activity timeline (merged, chronological)
- Comment composer (with type selector: comment, question, decision)

#### Epic Detail
- Epic description
- Progress bar (tasks done / total)
- Task breakdown by status
- Task list scoped to this epic

#### Activity Feed
- Chronological list of all activity
- Filter by entity type, actor, action
- Actor badges (human vs AI, with avatar/icon)

### Design System Notes

- Dark mode default (AI-friendly), light mode toggle
- Monospace font for task IDs, git refs, file paths
- Color coding: priority (red=critical, orange=high, blue=medium, gray=low)
- Actor distinction: human comments get one style, AI comments get another (subtle visual cue, not jarring)
- Responsive but desktop-first (minimum 1024px width)
- Keyboard shortcuts for power users (Cmd+K search, N for new task, etc.)

---

## 8. Git Integration Design

Git integration operates at two levels:

### Level 1: Reference Tracking (Phase 1)
Manual or API-driven linking of git refs to tasks. AI agents call `pm_link_git_ref` when they create branches or open PRs. Humans can add refs from the web UI.

### Level 2: Automated Tracking (Phase 3)
- **Branch naming convention**: Branches named `<prefix>/<task-id>-<slug>` (e.g., `feat/01J5K...3F-add-auth`) are auto-linked to tasks.
- **Commit message parsing**: Commits mentioning task IDs (e.g., `[PM-01J5K...]` or `refs: <task-id>`) are auto-linked.
- **Git hooks** (optional installable hooks):
  - `post-commit`: Notify PM server of new commits
  - `post-checkout`: Link branch to task if naming convention matches
- **Webhook endpoint** (`POST /api/v1/webhooks/git`): For CI/CD or GitHub webhook integration.

### Not in Scope (6 months)
- Full GitHub/GitLab API integration (reading PRs, CI status)
- Automatic PR creation
- Code review integration

---

## 9. AI Agent Workflow Model

### Identity
Each AI agent has a dedicated user account with `type: ai_agent`. Multiple Claude instances can share an identity (same token) or have distinct ones. The human director creates agent accounts and distributes tokens.

### Autonomy Guardrails (per-project settings)

| Capability | Default | Description |
|------------|---------|-------------|
| `can_self_assign` | true | Can pick tasks from ready queue |
| `can_create_subtasks` | true | Can break down assigned tasks |
| `can_create_tasks` | false | Can create new top-level tasks |
| `can_change_priority` | false | Can change task priority |
| `can_close_epics` | false | Can mark epics as completed |
| `max_concurrent_tasks` | 3 | Max tasks in_progress for this agent |

### Typical AI Agent Workflow

The AI agent operates in two modes: **Designer** (turning proposals into plans) and **Implementer** (executing tasks).

**Designer mode** (proposal → plan):
```
1. CHECK      → pm_list_proposals(status=open) or pm_list_proposals(status=discussing)
2. ENGAGE     → pm_get_proposal (read context)
                pm_discuss_proposal (ask questions, suggest approaches)
3. ITERATE    → (human responds, AI refines via pm_discuss_proposal)
4. WAIT       → human accepts or rejects the proposal
5. PLAN       → pm_implement_proposal (create epics + tasks from accepted proposal)
```

**Implementer mode** (task → done):
```
1. DISCOVER   → pm_list_tasks(status=ready) or pm_pick_next_task
2. CLAIM      → pm_start_task
3. PLAN       → pm_create_subtask (break down work if needed)
                pm_log_decision (record design choices)
                pm_set_task_context (update relevant files)
4. IMPLEMENT  → (do the work)
                pm_report_progress (periodic updates)
                pm_link_git_ref (link branch/commits)
5. COMPLETE   → pm_complete_task (with handoff summary)
                or pm_request_review (needs human review)
6. REPEAT     → check proposals first, then pm_pick_next_task
```

**Priority**: Proposals take priority over task execution. An AI agent should check for `open` or `discussing` proposals before picking up implementation work. The human director's intent should never be left waiting.

### Concurrency Safety
- `pick_next_task` uses a database transaction to atomically claim a task, preventing two agents from grabbing the same work.
- Task assignment checks `max_concurrent_tasks` before allowing a new claim.
- Status transitions are validated: only valid transitions are allowed (e.g., can't go from `done` back to `backlog`).

---

## 10. Auth & Security Model

### Design Principles
- Simple enough for local use, secure enough for LAN deployment
- No external auth providers needed
- API tokens never expire (but can be rotated)
- Sessions expire after configurable inactivity (default: 7 days)

### Implementation

#### First Run / Setup
On first launch, if no users exist, the system enters **setup mode**:
1. Web UI shows a setup wizard
2. User creates the first admin account (username + password)
3. System generates a default workspace
4. Admin can then create additional users (human or AI agent)

#### API Token Auth
- Tokens are generated server-side (crypto random, 256-bit)
- Stored as bcrypt hashes
- Transmitted in `Authorization: Bearer <token>` header
- One active token per user (rotation replaces old token)

#### Session Auth (Web UI)
- Login with username + password
- Server issues a session token (stored in `sessions` table)
- Set as HttpOnly cookie
- CSRF protection via `SameSite=Strict` + custom header check

#### Authorization
Simple role-based:
- **admin**: Full access. Can manage users, projects, settings.
- **member**: Can manage tasks, comments, epics within projects. Cannot manage users or workspace settings.

AI autonomy settings are **not** auth — they're workflow guardrails. An AI agent with `can_create_tasks: false` is a `member` who is additionally constrained by project policy, not by missing permissions.

---

## 11. Testing Strategy

### Unit Tests (Vitest)
- **Service layer**: Every service method tested with an in-memory SQLite database. Test business logic (workflow validation, dependency cycles, autonomy guardrails, atomic claim).
- **Route handlers**: Test request validation, response shapes, error cases.
- **Shared schemas**: Test Zod schema validation and type inference.
- **Frontend components**: Test with React Testing Library. Focus on interactive behavior (form submission, state changes), not snapshot tests.

### Integration Tests (Vitest)
- **API integration**: Spin up the full Hono app with a test SQLite database. Test complete request→response flows including auth, middleware, and database.
- **MCP server**: Test tool calls end-to-end (MCP tool → REST API → database → response).

### End-to-End Tests (Playwright)
- **Critical flows**:
  - Project creation
  - Task CRUD through the board
  - Task workflow (create → assign → start → review → complete)
  - AI agent workflow (pick next → start → complete)
  - Search
  - Auth (login, token management)
- **Cross-browser**: Chromium + Firefox minimum
- **Visual regression**: Optional, using Playwright's screenshot comparison

### Test Infrastructure
- Each test file gets a fresh SQLite database (in-memory for speed)
- Test fixtures/factories for creating test data (users, projects, tasks)
- Shared test utilities in a `test-utils` package
- CI: GitHub Actions (or local `pnpm test`) runs all tests

---

## 12. Deployment Model

### Local Development
```bash
pnpm install          # install all dependencies
pnpm dev              # starts API server + web dev server (Vite HMR)
```

### Production (Local)
```bash
pnpm build            # builds all packages
pnpm start            # starts production server (serves API + static web assets)
```

The production server is a single Node.js process:
- Serves the REST API on `/api/v1/*`
- Serves the SSE event stream on `/api/v1/events`
- Serves the pre-built React SPA on `/*` (with SPA fallback for client-side routing)
- SQLite database file at `./data/pm.db` (configurable via `PM_DB_PATH` env var)

### Docker (Optional)
```dockerfile
FROM node:22-alpine
# ... standard Node.js Docker pattern
# Exposes single port (default 3000)
# SQLite file in a mounted volume
```

### MCP Server
Separate process, configured in Claude's MCP settings. Communicates with the API server over localhost HTTP.

### Configuration
All configuration via environment variables (12-factor app):

| Variable | Default | Description |
|----------|---------|-------------|
| `PM_PORT` | 3000 | Server port |
| `PM_HOST` | 127.0.0.1 | Bind address (0.0.0.0 for LAN) |
| `PM_DB_PATH` | ./data/pm.db | SQLite database path |
| `PM_SESSION_SECRET` | (generated on first run) | Session signing secret |
| `PM_LOG_LEVEL` | info | Logging verbosity |

---

## 13. Six-Month Roadmap

### Phase 1: Foundation (Weeks 1-4)
**Goal**: End-to-end system running. A human can create proposals and discuss with AI. AI can read proposals and tasks via MCP.

**Epic 1.1: Project Scaffolding**
- Initialize monorepo (pnpm, Turborepo, TypeScript configs)
- Set up packages (server, web, shared, mcp-server)
- Configure ESLint, Prettier, Vitest, Playwright
- Create CLAUDE.md with development instructions
- CI pipeline (lint + test)

**Epic 1.2: Database & Core API**
- Drizzle schema for all tables (including proposals)
- Migration system
- CRUD routes for projects, proposals, epics, tasks, comments, labels
- Proposal-specific routes (transitions with role enforcement, work item creation)
- Request validation with Zod + OpenAPI spec generation
- Error handling middleware
- Unit + integration tests for all routes

**Epic 1.3: Basic Web UI**
- App shell (sidebar, header, routing)
- Project list page
- **Proposal list page** (primary entry point — status tabs, create form)
- **Proposal detail page** (description, discussion thread, status transitions)
- Task list page (table view with basic filters)
- Task detail view (read-only initially, then editable)
- API client (generated from OpenAPI)

**Epic 1.4: MCP Server (Read + Proposals)**
- MCP server scaffold with stdio transport
- Read tools: `pm_list_projects`, `pm_list_tasks`, `pm_get_task`, `pm_search`
- Proposal tools: `pm_list_proposals`, `pm_get_proposal`, `pm_discuss_proposal`
- API client for communicating with server
- Integration tests

### Phase 2: Workflow & AI Interface (Weeks 5-8)
**Goal**: AI agents can autonomously pick up and complete tasks. Humans see real-time updates.

**Epic 2.1: Auth System**
- User model with human/AI types
- API token auth middleware
- Session auth for web UI (login/logout)
- Setup wizard (first-run experience)
- User management UI (admin)

**Epic 2.2: Task Workflow Engine**
- Status transition validation
- Dependency management (add/remove, cycle detection)
- `pick_next_task` with atomic claim
- Autonomy guardrail enforcement
- Workflow-related API endpoints

**Epic 2.3: MCP Write Tools**
- `pm_implement_proposal` (create epics/tasks from accepted proposal)
- `pm_pick_next_task`, `pm_start_task`, `pm_complete_task`, `pm_request_review`
- `pm_create_task`, `pm_update_task`, `pm_add_comment`
- `pm_log_decision`, `pm_report_progress`, `pm_block_task`
- Full integration test suite

**Epic 2.4: Real-Time Updates**
- Event bus (in-process pub/sub)
- Activity log generation from events
- SSE endpoint for real-time streaming
- Frontend SSE integration (TanStack Query invalidation)
- Activity feed page

### Phase 3: Git Integration (Weeks 9-12)
**Goal**: Tasks are linked to code. AI agents report which files they changed.

**Epic 3.1: Git Ref Tracking**
- Git ref CRUD API
- MCP tools: `pm_link_git_ref`
- Task detail shows linked branches, commits, PRs
- Branch name convention parsing (auto-link)

**Epic 3.2: Task Context System**
- Context JSON field fully functional
- MCP tools: `pm_set_task_context`
- Web UI: context editor (file list, acceptance criteria)
- Context display in task detail view

**Epic 3.3: Structured Comments**
- Comment types (progress_update, decision, question, handoff)
- MCP tools: `pm_log_decision`, `pm_report_progress`
- Web UI: typed comment display (icons, structured rendering)
- Handoff view (what AI did, files changed, open questions)

### Phase 4: Rich UI (Weeks 13-18)
**Goal**: The web UI is a powerful project management tool.

**Epic 4.1: Kanban Board**
- Column-per-status layout
- Drag-and-drop (status transitions)
- Task cards with key metadata
- Swimlanes by epic (optional)
- Filter bar integration

**Epic 4.2: Dashboard**
- Project health charts (tasks by status, burndown-style)
- Active AI agents (what's in progress)
- Blocked tasks alert
- Recent activity summary
- My tasks widget

**Epic 4.3: Advanced Filtering & Views**
- Saved filter views (bookmarkable URLs)
- Grouping options (by epic, assignee, priority)
- Bulk operations (multi-select, batch status change, batch assign)
- Cmd+K search palette

**Epic 4.4: Epic & Milestone Management**
- Epic detail page with task progress
- Milestone management UI
- Epic-milestone association
- Timeline view (epics on a horizontal axis)

### Phase 5: Intelligence & Automation (Weeks 19-22)
**Goal**: The system automates routine operations.

**Epic 5.1: Automation Rules**
- Rule engine: "When X happens, do Y"
- Example rules:
  - "When all subtasks are done, move parent to in_review"
  - "When a task is blocked for >24h, notify admin"
  - "When an epic's tasks are all done, mark epic complete"
- Web UI for creating/managing rules

**Epic 5.2: Templates**
- Task templates (pre-filled fields + subtask sets)
- Project templates (project + epics + tasks skeleton)
- Web UI for template management

### Phase 6: Polish & Reliability (Weeks 23-26)
**Goal**: Production-ready for daily use.

**Epic 6.1: Data Management**
- JSON export/import (full project backup)
- Database backup/restore utility
- Data migration tools (for schema upgrades)

**Epic 6.2: Performance & UX Polish**
- Load testing with realistic data volumes
- Query optimization (slow query analysis)
- UI polish pass (loading states, error states, empty states)
- Keyboard shortcut system
- Dark/light mode
- Accessibility audit (WCAG 2.1 AA)

**Epic 6.3: Comprehensive E2E Test Suite**
- Full workflow E2E tests (human + AI agent flows)
- Cross-browser verification
- Error scenario coverage
- Performance regression tests

**Epic 6.4: Documentation**
- API documentation (auto-generated from OpenAPI)
- MCP server setup guide
- Development setup guide
- Architecture decision records

---

## 14. Key Design Decisions & Rationale

### Why Hono over Express/Fastify?
Hono has first-class Zod + OpenAPI integration via `@hono/zod-openapi`, making it trivial to define type-safe routes that auto-generate an OpenAPI spec. Express is legacy. Fastify is good but Hono's OpenAPI story is superior and its TypeScript types are tighter.

### Why SQLite over PostgreSQL?
Zero configuration. No separate database server to install or manage. Single file backup (copy the .db file). For 1-3 humans and a few AI agents, SQLite handles the load trivially. WAL mode enables concurrent reads with writes. If scaling becomes necessary, the Drizzle ORM abstraction makes migration to PostgreSQL straightforward.

### Why SSE over WebSocket?
SSE is simpler (HTTP-based, auto-reconnect, works through proxies), and we only need server→client push. Client→server communication goes through REST API calls. WebSocket would only be needed for real-time collaborative editing (e.g., two humans editing the same task description simultaneously), which is out of scope.

### Why MCP + REST instead of MCP only?
REST API is the universal layer — it serves the web frontend, scripts, and any non-Claude AI agent. MCP is a convenience layer for Claude specifically, providing high-level workflow tools (`pick_next_task`, `complete_task`) that abstract away multi-step REST operations. The MCP server is a thin client, not a separate service with its own logic.

### Why ULIDs over UUIDs or auto-increment?
ULIDs are sortable by creation time (useful for "most recent" queries), globally unique without coordination (important for offline or multi-agent scenarios), and URL-safe. Auto-increment leaks information (total count, creation order relative to other entities).

### Why a shared package?
Zod schemas defined once in `packages/shared` are the single source of truth. The server uses them for request validation, the frontend uses them for form validation, and the OpenAPI spec is generated from them. This eliminates type drift between packages.

### Why separate MCP server process?
MCP servers communicate via stdio (stdin/stdout). They need to be a standalone process that Claude launches. It can't be the same process as the HTTP server (which binds to a port and stays running). The MCP server is lightweight — it's essentially an HTTP client with MCP protocol wrapping.

### Why Proposals as a separate entity (not draft epics)?
Human directors express intent as vague, hand-wavy ideas — not as scoped epics. A single proposal might spawn zero epics (rejected), one epic, or several. Forcing ideas into the epic structure from the start creates a cardinality mismatch and mixes design discussion with implementation tracking. Proposals establish a clean role boundary: humans express intent, AI agents turn intent into structure. The human never needs to think about whether something is an epic vs. a task — that's the AI's job.

### Why proposals over epics as the primary entry point?
The human director's main interaction pattern is: "I have an idea, let's discuss it." This maps directly to creating a proposal, not to creating an epic (which implies the scope and structure are already decided). Proposals make the design conversation first-class and keep epics clean as execution containers.

---

## 15. Resolved Design Decisions

Decisions confirmed with the human director on 2026-05-27:

1. **Default workflow statuses**: `backlog → ready → in_progress → in_review → done` (plus `cancelled`). Minimal set that captures human-AI handoff points.
2. **Task effort scale**: T-shirt sizes (`xs`, `s`, `m`, `l`, `xl`). Simpler than story points, avoids false precision.
3. **Notifications**: Activity feed + SSE only. No browser push or email. Can be revisited in Phase 5.
4. **Multi-workspace**: Single workspace per installation. Schema supports multiple but UI won't expose it.
5. **Data portability**: Own JSON format only. No import from Jira/Linear/GitHub.
6. **Design process**: Proposals are a first-class entity. Humans create proposals, AI discusses and breaks them down into epics/tasks upon human approval. Humans never create epics/tasks directly.
