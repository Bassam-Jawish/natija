import { sql } from 'drizzle-orm';
import { ctx } from '../db';

/**
 * Next value of a per-lab counter, inside the current transaction (gap-free on commit).
 * Keys in use: `order:YYYY-MM-DD` (daily number), `patient`, `invoice:YYYY`.
 */
export async function nextCounter(key: string): Promise<number> {
  const { tx, labId } = ctx();
  const res = await tx.execute(
    sql`insert into counters (lab_id, key, value) values (${labId}, ${key}, 1)
        on conflict (lab_id, key) do update set value = counters.value + 1
        returning value`,
  );
  return Number((res.rows[0] as { value: string | number }).value);
}
