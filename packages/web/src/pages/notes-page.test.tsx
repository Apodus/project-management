import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Note, NoteFilters } from "@/lib/api";

// ── Capture the useNotes filter arg ────────────────────────────────
const useNotesSpy = vi.fn();
let notesData: Note[] = [];

function makeNote(overrides: Partial<Note>): Note {
  return {
    id: "note-1",
    projectId: "proj-1",
    kind: "bug",
    status: "open",
    title: "A note",
    body: "Some body text",
    anchorType: null,
    anchorId: null,
    codeLocator: null,
    severity: null,
    authorId: "user-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    triagedAt: null,
    triagedBy: null,
    triageOutcome: null,
    triageReason: null,
    promotedProposalId: null,
    promotedTaskId: null,
    ...overrides,
  };
}

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useNavigate: () => vi.fn(),
  // Render <Link> as a plain anchor so it mounts without a RouterProvider.
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/hooks/use-projects", () => ({
  useProject: () => ({ data: { id: "proj-1", name: "Demo project" } }),
}));

vi.mock("@/hooks/use-notes", () => ({
  useNotes: (_projectId: string | undefined, filters: NoteFilters) => {
    useNotesSpy(filters);
    return {
      data: { data: notesData, pagination: { total: notesData.length } },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/hooks/use-tasks", () => ({
  useTasks: () => ({
    data: { data: [{ id: "task-known", title: "Resolvable task" }] },
  }),
}));

vi.mock("@/hooks/use-epics", () => ({
  useEpics: () => ({ data: [{ id: "epic-1", name: "Alpha epic" }] }),
}));

vi.mock("@/hooks/use-proposals", () => ({
  useProposals: () => ({ data: [{ id: "prop-1", title: "Some proposal" }] }),
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { setCurrentProject: () => void }) => unknown) =>
    selector({ setCurrentProject: () => {} }),
}));

import { NotesPage } from "./notes-page";

beforeEach(() => {
  vi.clearAllMocks();
  notesData = [];
});

describe("NotesPage", () => {
  it("renders seeded note titles", () => {
    notesData = [
      makeNote({ id: "n1", title: "Login is broken" }),
      makeNote({ id: "n2", title: "Idea for caching", kind: "idea" }),
    ];
    render(<NotesPage />);
    expect(screen.getByText("Login is broken")).toBeInTheDocument();
    expect(screen.getByText("Idea for caching")).toBeInTheDocument();
  });

  it("filters rendered cards by the client-side search box (debounced)", async () => {
    notesData = [
      makeNote({ id: "n1", title: "Login is broken" }),
      makeNote({ id: "n2", title: "Idea for caching" }),
    ];
    render(<NotesPage />);
    fireEvent.change(screen.getByPlaceholderText("Search notes..."), {
      target: { value: "caching" },
    });
    // Search is debounced (300ms) — wait for the filtered render.
    await waitFor(() =>
      expect(screen.queryByText("Login is broken")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Idea for caching")).toBeInTheDocument();
  });

  it("shows the empty-state copy when there are no notes", () => {
    notesData = [];
    render(<NotesPage />);
    expect(screen.getByText("No notes yet")).toBeInTheDocument();
  });

  it("passes an empty NoteFilters by default", () => {
    notesData = [];
    render(<NotesPage />);
    const filters = useNotesSpy.mock.calls.at(-1)?.[0] as NoteFilters;
    expect(filters.kind).toBeUndefined();
    expect(filters.status).toBeUndefined();
    expect(filters.anchorType).toBeUndefined();
    expect(filters.severity).toBeUndefined();
  });

  it("shows 'Promoted' on a triaged+promoted note", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Promote me",
        status: "triaged",
        triageOutcome: "promoted",
        promotedTaskId: "task-known",
      }),
    ];
    render(<NotesPage />);
    expect(screen.getByText("Triaged · Promoted")).toBeInTheDocument();
    // Resolvable promoted target renders its title.
    expect(screen.getByText("Resolvable task")).toBeInTheDocument();
  });

  it("renders a resolvable anchor as the resolved title", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Anchored note",
        anchorType: "task",
        anchorId: "task-known",
      }),
    ];
    render(<NotesPage />);
    expect(screen.getByText("Resolvable task")).toBeInTheDocument();
  });

  it("renders raw type+id (NOT 'removed') when the anchor id is absent from the map", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Old anchor note",
        anchorType: "task",
        anchorId: "task-missing-abcdef0123",
      }),
    ];
    render(<NotesPage />);
    // Map miss → raw "task <short-id>", never "(removed)".
    expect(screen.getByText(/task task-mis/)).toBeInTheDocument();
    expect(screen.queryByText(/removed/i)).not.toBeInTheDocument();
  });
});
