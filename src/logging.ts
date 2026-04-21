import pino from 'pino';
import type { LogLevel } from './types';

export function createLogger(level: LogLevel, pretty: boolean) {
  return pino({
    level,
    errorKey: 'error',
    serializers: {
      error: pino.stdSerializers.err
    },
    transport: pretty
      ? {
          target: 'pino-pretty',
          options: { colorize: true, singleLine: true }
        }
      : undefined
  });
}
