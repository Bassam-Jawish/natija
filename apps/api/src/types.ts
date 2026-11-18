import 'fastify';
import type { Permission } from '@natija/domain';

export type AuthContext = {
  sessionId: string;
  userId: string;
  labId: string;
  permissions: Set<string>;
  roleKeys: string[];
  user: {
    id: string;
    username: string;
    fullNameAr: string;
    fullNameEn: string;
    title: string | null;
    language: 'ar' | 'en' | null;
    departmentIds: string[];
    branchIds: string[];
  };
};

export type AgentContext = { agentId: string; labId: string; name: string };

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    agent: AgentContext | null;
  }
  interface FastifyContextConfig {
    /** No sign-in needed (login, patient portal, health). */
    public?: boolean;
    /** Set false to skip the per-request lab transaction (long-lived streams, login). */
    tenant?: boolean;
    /** Any one of these permissions is enough. */
    perm?: Permission | Permission[];
    /** Authenticated by a Lab Agent bearer token instead of a staff session. */
    agent?: boolean;
    /** Skip the CSRF header check (only for non-cookie callers). */
    skipCsrf?: boolean;
  }
}
