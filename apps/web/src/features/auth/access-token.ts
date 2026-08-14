const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class AccessTokenStore {
  private token?: string;

  public get(): string | undefined {
    return this.token;
  }

  public set(token: string): void {
    if (token.length > 4_096 || !JWT.test(token))
      throw new Error("Invalid access token");
    this.token = token;
  }

  public clear(): void {
    this.token = undefined;
  }
}

export const accessTokenStore = new AccessTokenStore();
