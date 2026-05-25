import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

// Plain JSON to stdout — no pino-pretty dependency. Good enough for a recorder
// that mostly logs structured counters; pipe through `pino-pretty` manually if
// you want a human-readable stream during interactive runs.
export const logger = pino({ level });

export type Logger = typeof logger;
