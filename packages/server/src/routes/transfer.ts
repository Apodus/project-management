import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { TransferEntityType, UserType } from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
import * as transferService from "../services/transfer.service.js";

// Engine-independence C4-P4: POST /api/v1/{tasks|epics|proposals}/{id}/transfer.
// One route shape for the three kinds; the service is one implementation too.

const idParam = z
  .string()
  .min(1)
  .openapi({ param: { name: "id", in: "path" }, example: "01HXYZ1234567890ABCDEFGHIJ" });

const transferBody = z
  .object({
    target_project_id: z.string().min(1),
    target_epic_id: z.string().min(1).optional(),
    reason: z.string().trim().min(1).max(2048),
  })
  .openapi("TransferBody");

const transferResult = z
  .object({
    entity_type: z.enum(["task", "epic", "proposal"]),
    entity_id: z.string(),
    from_project_id: z.string(),
    to_project_id: z.string(),
    moved_task_ids: z.array(z.string()),
    dropped_labels: z.array(z.string()),
    dropped_milestone_id: z.string().nullable(),
    audit_id: z.string(),
  })
  .openapi("TransferResult");

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const KINDS: { kind: TransferEntityType; path: string; tag: string; what: string }[] = [
  {
    kind: "task",
    path: "tasks",
    tag: "Tasks",
    what: "a task (its comments, git refs, claim and dependencies follow; its epic is cleared unless target_epic_id names one of the target project)",
  },
  {
    kind: "epic",
    path: "epics",
    tag: "Epics",
    what: "an epic together with ALL of its tasks, atomically (its milestone is cleared; an epic with any epic dependency is refused)",
  },
  {
    kind: "proposal",
    path: "proposals",
    tag: "Proposals",
    what: "a proposal (its comments follow)",
  },
];

export function createTransferRoutes(): OpenAPIHono<{ Variables: AppVariables }> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();
  for (const k of KINDS) {
    const route = createRoute({
      method: "post",
      path: `/api/v1/${k.path}/{id}/transfer`,
      tags: [k.tag],
      summary: `Transfer ${k.kind} to another project`,
      description: `Move ${k.what} to another project of the same workspace, keeping its id. Project-scoped labels are dropped and listed. Refused (409) while a moving task has a queued/integrating merge request, a forming/integrating group, a held or queued merge lock or an open merge incident, or when a parent/subtask would stay behind. The claim holder or a human only. Audited (action "transfer") in the source project; an activity row "transferred" lands in both projects.`,
      request: {
        params: z.object({ id: idParam }),
        body: { content: { "application/json": { schema: transferBody } }, required: true },
      },
      responses: {
        200: {
          description: "Transferred",
          content: { "application/json": { schema: z.object({ data: transferResult }) } },
        },
        400: {
          description: "Validation error",
          content: { "application/json": { schema: errorEnvelope } },
        },
        403: {
          description: "Not the claim holder (agents)",
          content: { "application/json": { schema: errorEnvelope } },
        },
        404: {
          description: "Entity or project not found",
          content: { "application/json": { schema: errorEnvelope } },
        },
        409: {
          description:
            "Refused: work in flight, a split subtree, an epic dependency, another workspace, an archived target",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    });
    router.openapi(route, (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const user = c.get("currentUser") as AuthUser;
      const result = transferService.transfer(
        k.kind,
        id,
        { id: user.id, type: user.type as UserType },
        body,
      );
      return c.json({ data: result }, 200);
    });
  }
  return router;
}
