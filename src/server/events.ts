import EventEmitter from 'events';

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(1000);

export function emitSampleUpdate(
  jobId: string,
  sampleId: string,
  status: string,
  payload?: Record<string, unknown>
) {
  jobEvents.emit('sample', { jobId, sampleId, status, payload });
}

export function emitJobUpdate(jobId: string, status: string) {
  jobEvents.emit('job', { jobId, status });
}
