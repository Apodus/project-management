# Phase 4: Rich UI + Remaining Polish — Roadmap

**Goal**: The web UI becomes a powerful, pleasant-to-use project management tool. Kanban board with drag-and-drop, command palette, bulk operations, and enhanced epic/milestone views.

**Design reference**: `docs/design/high-level-design.md` — Section 7 (Frontend Design), Section 8 (Git Integration).

**Prerequisites**: Phases 1-2 complete. 672 tests, 20 MCP tools, auth, workflow engine, SSE real-time, dashboard, activity feed.

**Note**: Phase 3 (Git Integration) items are mostly done. This roadmap folds in the two remaining scraps: branch auto-linking and an inline context editor.

---

## Steps

### Step 1 — Phase 3 stragglers: branch auto-linking and context editor

Finish the two remaining Phase 3 items.

**Branch auto-linking**:
- Create `packages/server/src/services/git-auto-link.service.ts`:
  - `parseBranchName(branchName: string): { taskId: string, slug: string } | null` — parse branches matching `<prefix>/<task-id>-<slug>` pattern (e.g., `feat/01J5K3F-add-auth`). The prefix is configurable in project settings (`settings.git.branch_prefix`).
  - `autoLinkBranch(branchName: string): GitRef | null` — parse branch, find matching task, create git_ref if not already linked
- Add `POST /api/v1/webhooks/git` endpoint:
  - Accepts `{ event: "branch_created" | "commit_pushed", ref: string, project_id: string }`
  - Calls autoLinkBranch for branch events
  - For commit events: parse commit message for task ID references (`[PM-<id>]` or `refs: <id>`), create git_ref
  - No auth required (webhook secret validation can be added later)
- Tests for branch name parsing (various formats, invalid names)

**Context editor**:
- Update `packages/web/src/pages/task-detail-page.tsx`:
  - Make the context section editable inline:
    - "Relevant files": editable tag-style input (add/remove file paths)
    - "Acceptance criteria": editable list (add/remove/reorder items)
    - "Implementation hints": editable text field
    - "Design references": editable list
    - "Notes": editable text field
  - Changes save immediately via useUpdateTask mutation with context merge
  - Add/remove UI for list fields (small + button to add, x button to remove)

**Verify**: Build passes. Tests pass. Branch auto-linking correctly parses branch names and creates git refs. Context editor allows inline editing of all context fields.

### Step 2 — Kanban board

The centerpiece feature. Column-per-status layout with drag-and-drop.

- Install `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` in web package
- Create `packages/web/src/pages/board-page.tsx`:
  - Columns for each workflow status: Backlog, Ready, In Progress, In Review, Done
  - Each column shows:
    - Status header with task count badge
    - Scrollable list of task cards
  - Task cards show:
    - Title (truncated)
    - Priority badge (color-coded)
    - Type icon/badge
    - Assignee avatar/initials (or empty circle if unassigned)
    - Labels as colored dots
    - Epic name (if assigned, small text)
  - **Drag-and-drop**: Drag a card between columns to change status
    - On drop: call the task transition API (`POST /tasks/:id/transitions`)
    - If transition is invalid (e.g., backlog → done), show error toast and revert
    - Optimistic update: card moves immediately, reverts on API error
  - Filter bar (reuse pattern from task list):
    - Priority filter
    - Type filter
    - Assignee filter
    - Epic filter (swimlanes option)
    - Search
  - Swimlanes toggle: group by epic (horizontal sections, each with its own set of columns)
  - Click card → navigate to task detail
- Add `/projects/$projectId/board` route
- Update sidebar: "Board" nav item links to board page

**Verify**: Build passes. Typecheck passes. Board renders with columns. Cards are draggable between columns (triggers transition API). Filter bar works. Swimlane mode groups by epic.

### Step 3 — Command palette (Cmd+K)

Global search and navigation via keyboard.

- Install `cmdk` (command palette library) in web package — or build a lightweight version with shadcn Dialog + Command components (shadcn has a Command component based on cmdk)
- Add shadcn `Command` component if not already present
- Create `packages/web/src/components/command-palette.tsx`:
  - Opens with Cmd+K (or Ctrl+K on Windows)
  - Search input at top
  - Result sections:
    - **Tasks**: search API results for tasks (title, status badge, priority)
    - **Proposals**: search API results for proposals (title, status badge)
    - **Navigation**: hardcoded options (Dashboard, Board, Tasks, Epics, Activity, Settings)
    - **Actions**: Create Proposal, Create Project
  - Keyboard navigation: arrow keys to move, Enter to select
  - On select task/proposal: navigate to detail page
  - On select navigation: navigate to page
  - On select action: open relevant dialog
  - Debounced search (300ms)
  - Show recent items when query is empty
- Mount in app layout (renders globally when authenticated)
- Update header: make the search button trigger the command palette

**Verify**: Build passes. Typecheck passes. Cmd+K opens palette. Typing searches across entities. Arrow keys navigate. Enter selects. Escape closes.

### Step 4 — Bulk operations and advanced task list

Enhance the task list with multi-select and batch actions.

- Update `packages/web/src/pages/task-list-page.tsx`:
  - Add checkbox column (leftmost)
  - "Select all" checkbox in header
  - When tasks are selected, show a bulk action bar above the table:
    - "Change Status" dropdown → applies transition to all selected
    - "Change Priority" dropdown → updates priority for all selected
    - "Assign to" dropdown → assigns all selected to a user
    - "Clear selection" button
    - Selected count indicator: "3 tasks selected"
  - Bulk API: could make individual API calls for each task (acceptable for small scale) or add a batch endpoint
- Add grouping options:
  - Dropdown: "Group by: None / Epic / Assignee / Priority"
  - When grouped, tasks are displayed under section headers with counts
  - Collapsible groups
- URL-based filter state:
  - All active filters reflected in URL search params (status, priority, type, etc.)
  - Bookmarkable filtered views
  - Browser back/forward navigates filter history

**Verify**: Build passes. Typecheck passes. Can select multiple tasks. Bulk actions apply to selection. Grouping works. Filters persist in URL.

### Step 5 — Epic detail page and milestone management

Full epic and milestone views.

- Create `packages/web/src/pages/epic-detail-page.tsx`:
  - Epic name (editable), description (editable markdown)
  - Status badge, priority badge
  - Milestone association (dropdown to assign)
  - Progress section:
    - Progress bar (tasks done / total)
    - Task breakdown by status (mini bar chart or badge counts)
  - Task list scoped to this epic (reuse task list table, pre-filtered)
  - Proposal link (if epic was created from a proposal, show link back)
- Update epic list page: click epic → navigate to epic detail
- Add `/epics/$epicId` route
- Create `packages/web/src/pages/milestones-page.tsx`:
  - List of milestones with name, target date, status (open/closed), linked epic count
  - "New Milestone" dialog (name, description, target date)
  - Click to edit inline
  - Close/reopen toggle
- Add milestone API functions and hooks
- Add `/projects/$projectId/milestones` route
- Update sidebar: Milestones nav item (currently placeholder)

**Verify**: Build passes. Typecheck passes. Epic detail shows progress. Milestone CRUD works from UI.

### Step 6 — Dashboard enhancements and final polish

Polish the dashboard and ensure consistency across all views.

- Enhance `packages/web/src/pages/dashboard-page.tsx`:
  - **Status distribution chart**: Simple horizontal stacked bar showing task counts by status (use colored div segments — no chart library needed)
  - **Active AI agents widget**: Show tasks currently in_progress assigned to AI agent users. For each: task title, agent name, started_at (duration). If none active: "No AI agents currently working"
  - **Proposal pipeline widget**: Show proposal counts by status as a funnel/pipeline (open → discussing → accepted → implemented)
  - Polish existing widgets (my tasks, attention needed, recent activity)
- Ensure all pages have consistent:
  - Loading states (skeleton loaders)
  - Error states (error message with retry button)
  - Empty states (descriptive message with CTA where applicable)
- Add keyboard shortcuts help:
  - "?" key opens a shortcuts overlay showing: Cmd+K (search), N (new proposal when on proposals page)
- Final typecheck and lint pass across entire codebase

**Verify**: Build passes. Typecheck passes. Lint passes. Full build succeeds. Dashboard shows all widgets. Keyboard shortcut overlay works.

---

## Dependency DAG

```
depends_on:
  step_2: []
  step_3: []
  step_4: []
  step_5: []
  step_6: [step_2]
```

### Parallelism notes

Steps 1-5 are all independent — they modify different pages/components with no shared code changes. However, Steps 2-4 all modify the web package's routing and sidebar, which could cause merge conflicts. Safe parallel pairs:
- **Steps 1 and 2** (server git auto-link + web kanban — different packages)
- **Steps 3 and 5** (command palette + epic/milestone pages — different components)
- **Step 4** is safest to run after Step 2 (both touch task list patterns)
- **Step 6** depends on Step 2 (dashboard references board)

### Critical path

```
1 ──→ done (independent)
2 ──→ 6 ──→ done
3 ──→ done (independent)
4 ──→ done (independent, but after 2 preferred)
5 ──→ done (independent)
```

Longest path: 2 → 6 (2 sequential steps). Most steps are parallel.
