export const logger = {
  info(message, meta = {}) {
    console.info(formatLog('info', message, meta));
  },

  warn(message, meta = {}) {
    console.warn(formatLog('warn', message, meta));
  },

  error(message, meta = {}) {
    console.error(formatLog('error', message, meta));
  },
};

function formatLog(level, message, meta) {
  return JSON.stringify({
    level,
    message,
    ...meta,
    timestamp: new Date().toISOString(),
  });
}
