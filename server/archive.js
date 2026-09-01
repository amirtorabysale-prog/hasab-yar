import { deflateRawSync, inflateRawSync } from 'node:zlib';

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xEDB88320 : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[index]) & 0xff];
  return (crc ^ -1) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

export function buildZipArchive(files = []) {
  if (!Array.isArray(files) || !files.length) throw new Error('آرشیو بدون فایل ساخته نمی‌شود.');
  const entries = files.map(({ name, content }) => {
    const nameBuffer = Buffer.from(String(name || ''), 'utf8');
    if (!nameBuffer.length || nameBuffer.length > 240) throw new Error('نام یکی از فایل‌های آرشیو معتبر نیست.');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
    const compressed = deflateRawSync(raw, { level: 9 });
    return { nameBuffer, raw, data: compressed.length < raw.length ? compressed : raw,
      method: compressed.length < raw.length ? 8 : 0, crc: crc32(raw) };
  });
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.method, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(entry.crc, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.raw.length, 22);
    local.writeUInt16LE(entry.nameBuffer.length, 26);
    localParts.push(local, entry.nameBuffer, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.data.length, 20); central.writeUInt32LE(entry.raw.length, 24);
    central.writeUInt16LE(entry.nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, entry.nameBuffer);
    offset += 30 + entry.nameBuffer.length + entry.data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

export function readZipArchive(buffer) {
  let endOffset = -1;
  for (let index = buffer.length - 22; index >= 0 && index >= buffer.length - 66_000; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { endOffset = index; break; }
  }
  if (endOffset < 0) throw new Error('آرشیو ZIP معتبر نیست.');
  const count = buffer.readUInt16LE(endOffset + 10);
  let pointer = buffer.readUInt32LE(endOffset + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('ساختار آرشیو ZIP خراب است.');
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
