export const allowedPermissions = [
  "system.echo",
  "utility.calculator",
  "utility.datetime",
] as const;
export type AllowedPermission = (typeof allowedPermissions)[number];

export interface AuthenticatedPrincipal {
  readonly actorId: string;
  readonly sessionId: string;
  readonly permissions: readonly AllowedPermission[];
  readonly tokenIssuedAt: number;
  readonly tokenExpiresAt: number;
}
