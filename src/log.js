const GENERIC_SECRET_PATTERNS = [/bot\d+:[A-Za-z0-9_-]{8,}/g, /pcp_board_[A-Za-z0-9_-]+/g];

// Line logger that masks known secrets, and anything shaped like one, before writing.
export function createLogger({ secrets = [], out = process.stdout, err = process.stderr } = {}) {
  const known = secrets.filter((s) => typeof s === 'string' && s.length >= 4);

  function redact(text) {
    let result = String(text);
    for (const secret of known) result = result.split(secret).join('[redacted]');
    for (const pattern of GENERIC_SECRET_PATTERNS) result = result.replace(pattern, '[redacted]');
    return result;
  }

  function write(stream, level, message, fields) {
    const extra = fields
      ? Object.entries(fields)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')
      : '';
    const line = `${level} ${message}${extra ? ` ${extra}` : ''}`.replace(/[\r\n]+/g, ' ');
    stream.write(`${redact(line)}\n`);
  }

  return {
    info: (message, fields) => write(out, 'info', message, fields),
    warn: (message, fields) => write(err, 'warn', message, fields),
    error: (message, fields) => write(err, 'error', message, fields),
    redact,
  };
}
