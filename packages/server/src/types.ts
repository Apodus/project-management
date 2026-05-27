import type { Context } from "hono";

/**
 * Represents the current authenticated user attached to request context.
 * Nullable for now — auth validation is not yet implemented (Step 4 stub).
 */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  type: string;
}

/**
 * Context variables set by middleware and available to route handlers.
 */
export interface AppVariables {
  /** ULID generated per request */
  requestId: string;
  /** The authenticated user, or null if not authenticated */
  currentUser: AuthUser | null;
  /** The raw auth token extracted from header or cookie */
  authToken: string | null;
}

/**
 * Typed Hono context with our app-specific variables.
 */
export type AppContext = Context<{ Variables: AppVariables }>;

/**
 * Standard API error envelope returned by the error handler.
 */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Application error class for throwing structured errors from handlers/services.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
