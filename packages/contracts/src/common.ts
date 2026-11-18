import { z } from 'zod';

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const dateRangeQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export type Page<T> = { items: T[]; total: number };

/** RFC 9457 problem details, with a stable `code` the web app translates. */
export type Problem = {
  type?: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: Record<string, string[]>;
};

export type Bilingual = { ar: string; en: string };

export type Me = {
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
  lab: {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    taglineAr: string | null;
    taglineEn: string | null;
    logoSvg: string | null;
    brandColor: string;
    currency: string;
    timezone: string;
    settings: Record<string, unknown>;
  };
  roles: Array<{ key: string; nameAr: string; nameEn: string }>;
  permissions: string[];
  csrfToken: string;
};
