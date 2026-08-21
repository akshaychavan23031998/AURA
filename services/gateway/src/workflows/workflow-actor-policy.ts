import { and, eq } from "drizzle-orm";

import { allowedPermissions } from "../auth/principal.js";
import type { DatabaseClient } from "../db/client.js";
import { users, workflowPermissionGrants } from "../db/schema.js";

export class WorkflowActorPolicy {
  public constructor(private readonly database: DatabaseClient) {}

  public async resolve(actorId: string, workflowId: string) {
    const [actor] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, actorId), eq(users.status, "ACTIVE")))
      .limit(1);
    if (actor === undefined) return undefined;
    const grants = await this.database.db
      .select({ permission: workflowPermissionGrants.permission })
      .from(workflowPermissionGrants)
      .where(eq(workflowPermissionGrants.workflowId, workflowId));
    const allowed = new Set<string>(allowedPermissions);
    return {
      actorId: actor.id,
      grantedPermissions: grants
        .map(({ permission }) => permission)
        .filter((permission) => allowed.has(permission)),
    } as const;
  }
}
