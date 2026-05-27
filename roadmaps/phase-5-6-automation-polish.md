# Phase 5+6: Automation, Templates & Production Polish — Roadmap

**Goal**: The system automates routine operations, supports templates for repeatable work, has data export/import for safety, E2E tests for confidence, and runs as a single production-ready process.

**Note**: Phases 5 and 6 from the original design doc are combined because Phase 6 items (keyboard shortcuts, loading/error states, dark mode) were already shipped in earlier phases. The remaining work fits in one campaign.

**Design reference**: `docs/design/high-level-design.md` — Sections 13 (Phase 5 + 6 epics).

**Prerequisites**: Phases 1, 2, 4 complete. 713 tests, 21 MCP tools, full web UI with kanban board, command palette, auth, SSE real-time.

---

## Steps

### Step 1 — Automation rules engine (server)

Build the rule engine that reacts to events and triggers actions automatically.

- Create `automation_rules` table in the database:
  - `id` TEXT (ULID) PK
  - `project_id` TEXT FK → projects
  - `name` TEXT — human-readable rule name
  - `description` TEXT — what the rule does
  - `trigger_event` TEXT — event name to listen for (e.g., "task.status_changed", "task.created", "comment.created")
  - `conditions` TEXT (JSON) — conditions to evaluate (e.g., `{ "field": "status", "operator": "eq", "value": "done" }`)
  - `action_type` TEXT — what to do (e.g., "transition_task", "create_comment", "transition_epic")
  - `action_config` TEXT (JSON) — action parameters (e.g., `{ "to_status": "in_review" }`)
  - `is_active` INTEGER (boolean) — enable/disable
  - `created_at`, `updated_at` TEXT
  - `created_by` TEXT FK → users
- Generate migration
- Create `packages/server/src/services/automation.service.ts`:
  - `list(projectId)`, `getById(id)`, `create(data)`, `update(id, data)`, `delete(id)`, `toggle(id, active)`
  - `evaluateConditions(conditions, eventPayload)` — generic condition evaluator:
    - Supports operators: `eq`, `neq`, `in`, `not_in`, `contains`
    - Supports nested field access (e.g., `changes.status.to`)
    - Returns boolean
  - `executeAction(actionType, actionConfig, context)` — action executor:
    - `transition_task`: change task status
    - `transition_epic`: change epic status
    - `create_comment`: add automated comment
    - `notify`: add to activity log with special "automation" actor
- Create `packages/server/src/events/automation-listener.ts`:
  - Register on the event bus via `onAll()`
  - On each event: find active rules for the event's project where `trigger_event` matches
  - Evaluate conditions for each matching rule
  - Execute actions for rules where conditions pass
  - Guard against infinite loops: if an automation action triggers another event, track execution chain depth and stop at 3
- Built-in rules (created automatically for new projects, can be disabled):
  - "Auto-close epic": When all tasks in an epic are `done`, transition epic to `completed`
  - "Auto-advance parent": When all subtasks are `done`, transition parent task to `in_review`
- CRUD routes: `GET/POST /api/v1/projects/:projectId/automation-rules`, `PATCH/DELETE /api/v1/automation-rules/:id`
- Tests: rule CRUD, condition evaluation (all operators), action execution, event triggering, loop prevention

**Verify**: Build passes. Tests pass. Creating a rule that triggers on task.status_changed and transitions a parent task works end-to-end.

### Step 2 — Automation rules UI

Web interface for creating and managing automation rules.

- Create `packages/web/src/pages/settings/automation-page.tsx`:
  - Table of rules: name, trigger event, conditions summary, action summary, active toggle
  - "New Rule" button → Dialog/page with:
    - Name input
    - Trigger event dropdown (task.created, task.status_changed, task.assigned, comment.created, epic.updated, proposal.transitioned)
    - Conditions builder:
      - Field dropdown (depends on trigger — e.g., for task.status_changed: status, changes.status.from, changes.status.to, priority, type)
      - Operator dropdown (equals, not equals, in, contains)
      - Value input (text or dropdown for known values like statuses)
      - "Add condition" button for AND conditions
    - Action type dropdown (Transition task, Transition epic, Add comment)
    - Action config (depends on type — e.g., target status dropdown for transitions, comment body for add comment)
  - Edit rule: same form pre-filled
  - Delete rule with confirmation
  - Active/inactive toggle per rule
- Add API client functions and hooks for automation rules
- Add `/projects/$projectId/settings/automation` route
- Update sidebar: Settings dropdown or sub-navigation with "Automation" option
- Show built-in rules with a "Built-in" badge (they can be toggled but not deleted)

**Verify**: Build passes. Typecheck passes. Can create, edit, toggle, and delete rules from UI.

### Step 3 — Task and project templates

Templates for repeatable work patterns.

- Create `templates` table:
  - `id` TEXT (ULID) PK
  - `project_id` TEXT FK → projects, nullable (null = workspace-level template)
  - `name` TEXT
  - `description` TEXT
  - `template_type` TEXT — "task" or "project"
  - `template_data` TEXT (JSON) — the template content (see below)
  - `created_at`, `updated_at` TEXT
  - `created_by` TEXT FK → users
- Generate migration

**Task template** `template_data` structure:
```json
{
  "title_prefix": "Bug Fix: ",
  "description": "## Steps to reproduce\n\n## Expected behavior\n\n## Actual behavior",
  "type": "bug",
  "priority": "high",
  "estimated_effort": "m",
  "context": { "acceptance_criteria": ["Bug is fixed", "Tests pass"] },
  "subtasks": [
    { "title": "Investigate root cause", "type": "research", "effort": "s" },
    { "title": "Implement fix", "type": "feature", "effort": "m" },
    { "title": "Write regression test", "type": "chore", "effort": "s" }
  ]
}
```

**Project template** `template_data` structure:
```json
{
  "description": "Standard web feature project",
  "epics": [
    { "name": "Design", "tasks": [{ "title": "Create design doc", "type": "design" }] },
    { "name": "Implementation", "tasks": [{ "title": "Core implementation", "type": "feature" }] },
    { "name": "Testing", "tasks": [{ "title": "E2E tests", "type": "chore" }] }
  ],
  "labels": [
    { "name": "frontend", "color": "#3b82f6" },
    { "name": "backend", "color": "#10b981" }
  ]
}
```

- Create `packages/server/src/services/template.service.ts`:
  - `list(projectId?)`, `getById(id)`, `create(data)`, `update(id, data)`, `delete(id)`
  - `createTaskFromTemplate(templateId, projectId, overrides?)` — creates task + subtasks from template
  - `createProjectFromTemplate(templateId, overrides?)` — creates project + epics + tasks + labels
  - `createTemplateFromTask(taskId)` — snapshot a task as a template (including subtasks)
- CRUD routes + instantiation routes:
  - `GET/POST /api/v1/templates`, `PATCH/DELETE /api/v1/templates/:id`
  - `POST /api/v1/templates/:id/instantiate` — create task or project from template
- MCP tools:
  - `pm_list_templates` — list available templates
  - `pm_use_template` — instantiate a template to create tasks or projects
- Tests for template CRUD, task instantiation (with subtasks), project instantiation (with epics/tasks/labels)

**Verify**: Build passes. Tests pass. Can create a template, instantiate it, get correct task hierarchy.

### Step 4 — Templates UI

Web interface for creating and using templates.

- Create `packages/web/src/pages/settings/templates-page.tsx`:
  - Two tabs: "Task Templates" and "Project Templates"
  - Each shows a list of templates with name, description, type, "Use" button
  - "New Template" dialog:
    - Name, description
    - For task: prefilled fields (title pattern, type, priority, effort, description, subtask list)
    - For project: epics with nested tasks, labels
  - "Create from existing" option: select a task → auto-create template from it
  - "Use Template" button → dialog asking for overrides (title, project) → creates the entity
- Add API client functions and hooks
- Add route under settings
- On task list page: add "New from Template" option in create dialog

**Verify**: Build passes. Typecheck passes. Can create and use templates from UI.

### Step 5 — JSON export/import and backup

Data portability and safety.

- Create `packages/server/src/services/export.service.ts`:
  - `exportProject(projectId)` — exports complete project as JSON:
    - Project metadata
    - All epics, tasks (with subtasks), comments, labels, task_labels, dependencies, git_refs, milestones, proposals
    - Activity log (optional, can be large)
    - Preserves all IDs and relationships
  - `importProject(data, workspaceId)` — imports a project from exported JSON:
    - Creates new IDs for all entities (to avoid conflicts)
    - Maintains internal relationship references (remaps old IDs to new)
    - Validates data structure before import
  - `exportWorkspace()` — exports everything (all projects)
  - `backupDatabase()` — copies the SQLite file to a backup location
- Routes:
  - `GET /api/v1/projects/:id/export` — download project JSON
  - `POST /api/v1/projects/import` — upload and import project JSON
  - `GET /api/v1/backup` — trigger database backup, return backup path
- Web UI additions:
  - Project settings/actions: "Export Project" button (downloads JSON file)
  - Projects page: "Import Project" button (file upload dialog)
  - Settings: "Backup Database" button
- Tests for export/import round-trip (export → import → verify data matches)

**Verify**: Build passes. Tests pass. Export a project, import it, verify all data preserved with new IDs.

### Step 6 — Production server and deployment

Make the app runnable as a single process in production.

- Update `packages/server/src/index.ts`:
  - In production mode, serve the built web UI as static assets from `packages/web/dist/`
  - SPA fallback: any request not matching `/api/*` or a static file returns `index.html`
  - Use `hono/serve-static` or a custom middleware
  - Detect production via `NODE_ENV=production` or absence of Vite dev server
- Add `pnpm start` script to root package.json:
  - Runs `pnpm build` then starts the server
  - Single command to go from zero to running app
- Create `.env.example` with all configuration variables documented
- Update `CLAUDE.md` with:
  - Production deployment instructions
  - MCP server configuration guide (how to add to Claude's MCP settings)
  - All available environment variables
  - Architecture overview

**Verify**: `pnpm build && pnpm start` serves both API and web UI on port 3000. Navigating to http://localhost:3000 shows the web app. API endpoints at /api/v1/* still work.

### Step 7 — E2E tests and final verification

Playwright E2E tests for critical user flows.

- Install Playwright in the project: `pnpm add -D @playwright/test` at root
- Create `tests/e2e/` directory
- Configure Playwright (`playwright.config.ts`):
  - Start server before tests (`pnpm start` with test DB)
  - Base URL: http://localhost:3000
  - Browsers: Chromium (primary), Firefox (secondary)
- Critical flow tests:
  - `setup-and-login.spec.ts`: First visit → setup wizard → create admin → login → see dashboard
  - `project-workflow.spec.ts`: Create project → create proposal → add comment → accept proposal → verify tasks appear
  - `task-management.spec.ts`: View task list → filter by status → open task detail → change status via transition → verify kanban board reflects change
  - `user-management.spec.ts`: Login as admin → create AI agent user → verify token shown → create human user
  - `search.spec.ts`: Create tasks → search via Cmd+K → verify results → navigate to result
- Test utilities: helper to reset DB between tests, helper to login

**Verify**: `pnpm test:e2e` runs all Playwright tests. All pass in Chromium. Build is green.

---

## Dependency DAG

```
depends_on:
  step_2: [step_1]
  step_4: [step_3]
  step_5: []
  step_6: []
  step_7: [step_6]
```

### Parallelism notes

- **Steps 1 and 3** are independent (automation rules vs templates — different tables, services)
- **Steps 5 and 6** are independent (export/import vs production server)
- **Step 2** depends on Step 1 (needs automation API)
- **Step 4** depends on Step 3 (needs template API)
- **Step 7** depends on Step 6 (needs production server for E2E)

### Critical path

```
1 → 2 ──→ done
3 → 4 ──→ done
5 ──────→ done
6 → 7 ──→ done
```

Four independent chains. Max 2 sequential steps.
