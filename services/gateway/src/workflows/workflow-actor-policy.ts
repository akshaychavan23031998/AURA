import { and, eq } from "drizzle-orm";

import { allowedPermissions } from "../auth/principal.js";
import type { DatabaseClient } from "../db/client.js";
import { users, workflowPermissionGrants, workflows } from "../db/schema.js";

export class WorkflowActorPolicy {
  public constructor(private readonly database: DatabaseClient) {}

  public async resolve(actorId: string, workflowId: string) {
    const [workflow] = await this.database.db
      .select({
        actorId: workflows.actorId,
      })
      .from(workflows)
      .innerJoin(
        users,
        and(eq(users.id, workflows.actorId), eq(users.status, "ACTIVE")),
      )
      .where(and(eq(workflows.id, workflowId), eq(workflows.actorId, actorId)))
      .limit(1);

    if (workflow === undefined) return undefined;

    const grants = await this.database.db
      .select({
        permission: workflowPermissionGrants.permission,
      })
      .from(workflowPermissionGrants)
      .where(eq(workflowPermissionGrants.workflowId, workflowId));

    const allowed = new Set<string>(allowedPermissions);

    return {
      actorId: workflow.actorId,
      grantedPermissions: grants
        .map(({ permission }) => permission)
        .filter((permission) => allowed.has(permission)),
    } as const;
  }
}
