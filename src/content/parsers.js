const DURATION_UNITS = {
  ms: 1,
  s: 1000,
  min: 60000,
  h: 3600000,
  d: 86400000,
};

const BYTE_UNITS = {
  b: 1,
  kib: 1024, kb: 1024,
  mib: 1048576, mb: 1048576,
  gib: 1073741824, gb: 1073741824,
  tib: 1099511627776, tb: 1099511627776,
  pib: 1125899906842624, pb: 1125899906842624,
  eib: 1152921504606846976, eb: 1152921504606846976,
};

export function parseDuration(str) {
  if (!str || typeof str !== 'string') return Number.NaN;
  str = str.trim();
  if (str === '' || str === '-') return Number.NaN;

  const match = str.match(/^([\d.]+)\s*(ms|s|min|h|d)$/i);
  if (match) {
    const val = Number.parseFloat(match[1]);
    const multiplier = DURATION_UNITS[match[2].toLowerCase()];
    if (multiplier) return val * multiplier;
  }

  // Only return bare number if string has no letter suffixes (avoids
  // matching byte values like "2.0 GiB" as 2.0 ms duration).
  if (!/[a-zA-Z]/.test(str)) {
    const bare = Number.parseFloat(str);
    if (!Number.isNaN(bare)) return bare;
  }
  return Number.NaN;
}

export function parseBytes(str) {
  if (!str || typeof str !== 'string') return Number.NaN;
  str = str.trim();
  if (str === '' || str === '-') return Number.NaN;

  // Handle compound strings like "1.5 GiB / 1000"
  const slashIdx = str.indexOf('/');
  if (slashIdx !== -1) str = str.substring(0, slashIdx).trim();

  const match = str.match(
    /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|PiB|KB|MB|GB|TB|PB|EiB|EB)$/i
  );
  if (match) {
    const val = Number.parseFloat(match[1]);
    const multiplier = BYTE_UNITS[match[2].toLowerCase()];
    if (multiplier !== undefined) return val * multiplier;
  }

  const bare = Number.parseFloat(str);
  if (!Number.isNaN(bare)) return bare;
  return Number.NaN;
}

export function parseCellValue(str) {
  if (!str || typeof str !== 'string') return Number.NaN;
  str = str.trim();
  if (str === '' || str === '-') return Number.NaN;

  let val = parseDuration(str);
  if (!Number.isNaN(val)) return val;
  val = parseBytes(str);
  if (!Number.isNaN(val)) return val;
  return Number.parseFloat(str.replaceAll(',', ''));
}

export function cellText(td) {
  if (!td) return '';
  return (td.textContent || td.innerText || '').trim();
}

export function formatBytesHuman(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i >= units.length) i = units.length - 1;
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}
