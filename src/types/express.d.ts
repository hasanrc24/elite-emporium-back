type RuntimeValue = ReturnType<typeof JSON.parse>;

declare namespace Express {
  interface AuthenticatedUser {
    id: string;
    roleVersion: number;
  }

  interface AuthenticatedSession {
    id: string;
  }

  interface Request {
    id: string;
    auth: {
      user: AuthenticatedUser;
      session: AuthenticatedSession;
      permissions: Set<string>;
      claims: Record<string, unknown>;
    };
    cart: { id: string };
    wishlist: { id: string };
  }
}
