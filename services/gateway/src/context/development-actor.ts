export interface DevelopmentActorContext {
  readonly actorId: "local-dev-user";
  readonly grantedPermissions: readonly ["system.echo"];
}

export function deriveDevelopmentActorContext(): DevelopmentActorContext {
  return { actorId: "local-dev-user", grantedPermissions: ["system.echo"] };
}
