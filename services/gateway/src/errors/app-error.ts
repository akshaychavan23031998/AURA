export interface AppErrorOptions {
  readonly code: string;
  readonly httpStatus: number;
  readonly message: string;
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly details?: unknown;

  public constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.details = options.details;
  }
}
