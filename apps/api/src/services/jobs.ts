/**
 * Registry of periodic background jobs (instrument offline detection, overdue-work alerts, ...).
 * Modules register jobs with registerJob(); main.ts starts them after the server listens.
 */
type Job = { name: string; everyMs: number; run: () => Promise<void> };

const jobs: Job[] = [];
const timers: NodeJS.Timeout[] = [];

export function registerJob(job: Job): void {
  if (!jobs.some((j) => j.name === job.name)) jobs.push(job);
}

export function startBackgroundJobs(): void {
  for (const job of jobs) {
    const timer = setInterval(() => {
      job.run().catch((err) => console.error(`job ${job.name} failed`, err));
    }, job.everyMs);
    timer.unref();
    timers.push(timer);
  }
}

export function stopBackgroundJobs(): void {
  while (timers.length) clearInterval(timers.pop()!);
}
