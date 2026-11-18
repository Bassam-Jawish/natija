import type { FastifyInstance } from 'fastify';
import { desc, eq, ilike, isNull, or, and } from 'drizzle-orm';
import { z } from 'zod';
import { orders, patients, samples } from '@natija/db';
import { normalizeText } from '@natija/domain';
import { db } from '../../db';
import { parse } from '../../lib/http';

/** One box for the command palette and barcode scanners: patients, orders and tubes. */
export default async function searchRoutes(app: FastifyInstance) {
  app.get('/', { config: { perm: ['patients.read', 'orders.read'] } }, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(80) }), req.query);
    const term = normalizeText(q);
    const like = `%${term.replace(/[%_]/g, '')}%`;
    const prefix = `${q.replace(/[%_]/g, '')}%`;

    const [patientRows, orderRows, sampleRows] = await Promise.all([
      db()
        .select({
          id: patients.id,
          mrn: patients.mrn,
          fullNameAr: patients.fullNameAr,
          fullNameEn: patients.fullNameEn,
          sex: patients.sex,
          birthDate: patients.birthDate,
          phone: patients.phone,
        })
        .from(patients)
        .where(and(isNull(patients.deletedAt), isNull(patients.mergedIntoId), or(ilike(patients.searchText, like), ilike(patients.mrn, prefix))))
        .orderBy(desc(patients.createdAt))
        .limit(6),
      db()
        .select({ id: orders.id, accession: orders.accession, status: orders.status, createdAt: orders.createdAt, patientName: patients.fullNameAr })
        .from(orders)
        .innerJoin(patients, eq(patients.id, orders.patientId))
        .where(ilike(orders.accession, prefix))
        .orderBy(desc(orders.createdAt))
        .limit(6),
      db()
        .select({ id: samples.id, barcode: samples.barcode, status: samples.status, orderId: samples.orderId })
        .from(samples)
        .where(ilike(samples.barcode, prefix))
        .limit(6),
    ]);
    return { patients: patientRows, orders: orderRows, samples: sampleRows };
  });
}
