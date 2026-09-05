import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { acceptReceiptImage, detectImageType } from '../server/imageIntake.js';

// فایل‌های آزمون ساختگی و بازتولیدپذیرند: هیچ عکس واقعی رسیدی وارد مخزن نمی‌شود.

function jpegSegment(marker, body) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xff00 | marker, 0);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
}

function buildJpeg({ withExif = true, width = 640, height = 480 } = {}) {
  const sof = Buffer.alloc(6 + 3);
  sof.writeUInt8(8, 0);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof.writeUInt8(1, 5);
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(jpegSegment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9)])));
  if (withExif) {
    // APP1 حاوی EXIF با یک برچسب GPS ساختگی — دقیقاً چیزی که نباید ذخیره شود.
    parts.push(jpegSegment(0xe1, Buffer.concat([
      Buffer.from('Exif\0\0', 'latin1'),
      Buffer.from('MM\0*', 'latin1'),
      Buffer.from('GPSLatitude 35.6892 GPSLongitude 51.3890', 'latin1'),
    ])));
    parts.push(jpegSegment(0xfe, Buffer.from('نام دستگاه و یادداشت خصوصی', 'utf8')));
  }
  parts.push(jpegSegment(0xc0, sof));
  parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  parts.push(Buffer.from([0x12, 0x34, 0x56, 0x78]));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function pngChunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0, 0);
  return Buffer.concat([length, typed, crc]);
}

function buildPng({ withMetadata = true, width = 320, height = 240 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(0, 9);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)];
  if (withMetadata) {
    parts.push(pngChunk('tEXt', Buffer.from('Comment\0محل ثبت عکس', 'utf8')));
    parts.push(pngChunk('eXIf', Buffer.from('MM\0*GPSLatitude', 'latin1')));
  }
  parts.push(pngChunk('IDAT', deflateSync(Buffer.alloc(16))));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function riffChunk(type, body) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  const padding = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, body, padding]);
}

function buildWebp({ withMetadata = true, width = 800, height = 600 } = {}) {
  const vp8x = Buffer.alloc(10);
  vp8x.writeUInt8(withMetadata ? 0x0c : 0x00, 0);
  const w = width - 1;
  const h = height - 1;
  vp8x[4] = w & 0xff; vp8x[5] = (w >> 8) & 0xff; vp8x[6] = (w >> 16) & 0xff;
  vp8x[7] = h & 0xff; vp8x[8] = (h >> 8) & 0xff; vp8x[9] = (h >> 16) & 0xff;

  const chunks = [riffChunk('VP8X', vp8x)];
  if (withMetadata) {
    chunks.push(riffChunk('EXIF', Buffer.from('MM\0*GPSLatitude 35.6892', 'latin1')));
    chunks.push(riffChunk('XMP ', Buffer.from('<x:xmpmeta>محل</x:xmpmeta>', 'utf8')));
  }
  chunks.push(riffChunk('VP8 ', Buffer.from([0x00, 0x01, 0x02, 0x03])));

  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

test('the real format is read from the bytes, never from the client label', () => {
  assert.equal(detectImageType(buildJpeg()), 'image/jpeg');
  assert.equal(detectImageType(buildPng()), 'image/png');
  assert.equal(detectImageType(buildWebp()), 'image/webp');
  assert.equal(detectImageType(Buffer.from('<html><script>alert(1)</script></html>')), null);
});

test('a non-image body labelled as an image is refused', () => {
  const html = Buffer.from('<html><body>یک فایل که تصویر نیست</body></html>');
  assert.throws(
    () => acceptReceiptImage(html, 'image/png'),
    (error) => error.code === 'RECEIPT_IMAGE_UNSUPPORTED' && error.status === 400,
  );
  assert.throws(() => acceptReceiptImage(Buffer.alloc(0), 'image/jpeg'), (error) => error.status === 400);
});

test('a mislabelled but genuine image is accepted under its real type', () => {
  const result = acceptReceiptImage(buildPng(), 'image/jpeg');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.declaredMismatch, true);
});

test('JPEG EXIF and comments are stripped while the image data survives', () => {
  const original = buildJpeg({ withExif: true });
  assert.ok(original.includes(Buffer.from('GPSLatitude', 'latin1')), 'فایل آزمون باید واقعاً GPS داشته باشد');

  const result = acceptReceiptImage(original, 'image/jpeg');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.width, 640);
  assert.equal(result.height, 480);
  assert.ok(!result.buffer.includes(Buffer.from('GPSLatitude', 'latin1')), 'مختصات GPS نباید باقی بماند');
  assert.ok(!result.buffer.includes(Buffer.from('یادداشت خصوصی', 'utf8')));
  assert.ok(result.buffer.includes(Buffer.from('JFIF', 'latin1')), 'JFIF برای نمایش لازم است');
  // دادهٔ فشردهٔ تصویر و نشانهٔ پایان دست‌نخورده می‌مانند.
  assert.ok(result.buffer.includes(Buffer.from([0x12, 0x34, 0x56, 0x78])));
  assert.deepEqual(result.buffer.subarray(-2), Buffer.from([0xff, 0xd9]));
  assert.ok(result.bytesRemoved > 0);
});

test('a JPEG with nothing to strip comes back byte-identical', () => {
  const clean = buildJpeg({ withExif: false });
  const result = acceptReceiptImage(clean, 'image/jpeg');
  assert.deepEqual(result.buffer, clean);
  assert.equal(result.bytesRemoved, 0);
});

test('PNG text and eXIf chunks are stripped and the file stays valid', () => {
  const result = acceptReceiptImage(buildPng({ withMetadata: true }), 'image/png');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
  assert.ok(!result.buffer.includes(Buffer.from('GPSLatitude', 'latin1')));
  assert.ok(!result.buffer.includes(Buffer.from('محل ثبت عکس', 'utf8')));
  assert.ok(result.buffer.includes(Buffer.from('IHDR', 'latin1')));
  assert.ok(result.buffer.includes(Buffer.from('IDAT', 'latin1')));
  assert.ok(result.buffer.subarray(-8).includes(Buffer.from('IEND', 'latin1')));
});

test('WebP EXIF and XMP chunks are stripped and the header flags are cleared', () => {
  const result = acceptReceiptImage(buildWebp({ withMetadata: true }), 'image/webp');
  assert.equal(result.mimeType, 'image/webp');
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.ok(!result.buffer.includes(Buffer.from('GPSLatitude', 'latin1')));
  assert.ok(!result.buffer.includes(Buffer.from('xmpmeta', 'latin1')));
  // بیت‌های EXIF و XMP در VP8X باید خاموش شده باشند، وگرنه فایل ناسازگار می‌شود.
  const vp8xFlags = result.buffer[20];
  assert.equal(vp8xFlags & 0x0c, 0);
  // اندازهٔ RIFF باید با طول واقعی فایل بخواند.
  assert.equal(result.buffer.readUInt32LE(4), result.buffer.length - 8);
});

test('a truncated or malformed image is refused instead of stored', () => {
  const jpeg = buildJpeg();
  assert.throws(() => acceptReceiptImage(jpeg.subarray(0, 30), 'image/jpeg'), (error) => error.status === 400);

  const png = buildPng();
  assert.throws(() => acceptReceiptImage(png.subarray(0, png.length - 12), 'image/png'), (error) => error.status === 400);

  // PNG بدون IDAT فقط یک اسکلت است، نه تصویر.
  const headerOnly = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', (() => { const b = Buffer.alloc(13); b.writeUInt32BE(10, 0); b.writeUInt32BE(10, 4); b.writeUInt8(8, 8); return b; })()),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => acceptReceiptImage(headerOnly, 'image/png'), (error) => error.status === 400);
});

test('an image with absurd dimensions is refused before it reaches the ledger', () => {
  assert.throws(
    () => acceptReceiptImage(buildPng({ width: 40_000, height: 40_000 }), 'image/png'),
    (error) => error.code === 'RECEIPT_IMAGE_TOO_LARGE',
  );
  assert.throws(
    () => acceptReceiptImage(buildJpeg({ width: 30_000, height: 100 }), 'image/jpeg'),
    (error) => error.code === 'RECEIPT_IMAGE_TOO_LARGE',
  );
});
