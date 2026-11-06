import type { Membership, User, Workspace } from '../db/schema.ts';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      workspace?: Workspace;
      membership?: Membership;
      rawBody?: Buffer;
    }
  }
}

export {};
