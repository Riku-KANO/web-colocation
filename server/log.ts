// Minimal structured logger: one JSON object per line (for log collectors) or a readable line.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  level: LogLevel = 'info',
  format: 'json' | 'pretty' = 'json',
  write: (line: string, level: LogLevel) => void = (line, lv) => (lv === 'error' || lv === 'warn' ? console.error(line) : console.log(line)),
): Logger {
  const emit = (lv: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lv] < ORDER[level]) return;
    if (format === 'json') {
      write(JSON.stringify({ time: new Date().toISOString(), level: lv, msg, ...fields }), lv);
    } else {
      const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
      write(`[colo] ${lv.toUpperCase().padEnd(5)} ${msg}${extra}`, lv);
    }
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
