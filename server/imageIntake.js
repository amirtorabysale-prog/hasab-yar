// فاز ۴.۳ — اعتبارسنجی باینری و پاک‌سازی متادیتای تصویر رسید.
//
// دو مسئلهٔ واقعی که تا امروز پاسخ نداشتند:
//
// ۱. تنها کنترل روی نوع فایل، هدر `Content-Type` بود که خودِ کلاینت می‌فرستد.
//    یعنی هر بایتی با برچسب `image/png` ذخیره می‌شد و بعداً با همان برچسب
//    برگردانده می‌شد. `nosniff` جلوی بهره‌برداری را می‌گیرد، اما ذخیرهٔ محتوای
//    دلخواه در پایگاه‌دادهٔ مالی به‌هرحال درست نیست.
// ۲. عکس رسیدی که با موبایل گرفته می‌شود EXIF دارد و EXIF مختصات GPS دارد.
//    محل زندگی صاحب کسب‌وکار داخل رسید یک هزینهٔ شخصی، دادهٔ لازم نیست.
//
// این ماژول نوع واقعی را از بایت‌های آغازین می‌خواند، ساختار را تا انتها
// می‌پیماید تا فایل بریده یا دست‌کاری‌شده رد شود، و بخش‌های متادیتا را حذف
// می‌کند. هیچ وابستگی بیرونی لازم نیست؛ هر سه قالب فقط بازنویسی بخش‌اند.

const MAX_PIXELS_PER_SIDE = 12_000;

export const SUPPORTED_RECEIPT_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

function intakeError(message, code = 'RECEIPT_IMAGE_INVALID') {
  return Object.assign(new Error(message), { code, status: 400 });
}

/** نوع واقعی را از امضای بایتی می‌خواند، نه از ادعای کلاینت. */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function assertDimensions(width, height) {
  if (!width || !height) return;
  if (width > MAX_PIXELS_PER_SIDE || height > MAX_PIXELS_PER_SIDE) {
    throw intakeError(`ابعاد تصویر بیش از ${MAX_PIXELS_PER_SIDE} پیکسل است؛ یک عکس معمولی رسید بفرست.`, 'RECEIPT_IMAGE_TOO_LARGE');
  }
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

// نشانگرهای بدون بدنه: RSTn، SOI، EOI و TEM.
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);
// APP1..APP15 و COM حامل EXIF، XMP، پروفایل و یادداشت‌اند و برای نمایش رسید لازم نیستند.
const JPEG_STRIPPED = new Set([0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xfe]);
// SOFn هرکدام ابعاد را حمل می‌کنند؛ C4 (DHT)، C8 (JPG) و CC (DAC) استثنا هستند.
const JPEG_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function sanitizeJpeg(buffer) {
  const parts = [buffer.subarray(0, 2)];
  let width = 0;
  let height = 0;
  let offset = 2;
  let sawFrame = false;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) throw intakeError('ساختار فایل JPEG سالم نیست.');
    // میان بخش‌ها ممکن است چند بایت 0xFF پرکننده بیاید.
    let marker = offset + 1;
    while (marker < buffer.length && buffer[marker] === 0xff) marker += 1;
    if (marker >= buffer.length) throw intakeError('فایل JPEG ناقص است.');
    const code = buffer[marker];

    if (code === 0xd9) { parts.push(buffer.subarray(offset, marker + 1)); offset = marker + 1; break; }
    if (JPEG_STANDALONE.has(code)) { parts.push(buffer.subarray(offset, marker + 1)); offset = marker + 1; continue; }
    if (marker + 3 > buffer.length) throw intakeError('فایل JPEG ناقص است.');

    const length = buffer.readUInt16BE(marker + 1);
    if (length < 2) throw intakeError('طول بخش JPEG معتبر نیست.');
    const end = marker + 1 + length;
    if (end > buffer.length) throw intakeError('فایل JPEG ناقص است.');

    if (JPEG_FRAME.has(code)) {
      if (end < marker + 8) throw intakeError('سرآیند تصویر JPEG ناقص است.');
      height = buffer.readUInt16BE(marker + 4);
      width = buffer.readUInt16BE(marker + 6);
      sawFrame = true;
    }

    if (!JPEG_STRIPPED.has(code)) parts.push(buffer.subarray(offset, end));

    if (code === 0xda) {
      // از SOS به بعد دادهٔ فشردهٔ تصویر است و تا انتها دست‌نخورده کپی می‌شود.
      parts.push(buffer.subarray(end));
      offset = buffer.length;
      break;
    }
    offset = end;
  }

  if (!sawFrame) throw intakeError('این فایل تصویر JPEG معتبری نیست.');
  assertDimensions(width, height);
  return { buffer: Buffer.concat(parts), width, height };
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

// بخش‌های حامل متن، زمان و EXIF حذف می‌شوند؛ بقیه برای نمایش درست لازم‌اند.
const PNG_STRIPPED = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function sanitizePng(buffer) {
  const parts = [buffer.subarray(0, 8)];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length) throw intakeError('طول بخش PNG معتبر نیست.');
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const end = offset + 12 + length;
    if (end > buffer.length) throw intakeError('فایل PNG ناقص است.');

    if (type === 'IHDR') {
      if (length < 13) throw intakeError('سرآیند PNG ناقص است.');
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      sawHeader = true;
    }
    if (type === 'IDAT') sawData = true;
    if (!PNG_STRIPPED.has(type)) parts.push(buffer.subarray(offset, end));
    offset = end;
    if (type === 'IEND') { sawEnd = true; break; }
  }

  if (!sawHeader || !sawData || !sawEnd) throw intakeError('این فایل تصویر PNG معتبری نیست.');
  assertDimensions(width, height);
  return { buffer: Buffer.concat(parts), width, height };
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

const WEBP_STRIPPED = new Set(['EXIF', 'XMP ']);

function sanitizeWebp(buffer) {
  const declared = buffer.readUInt32LE(4);
  // اندازهٔ ثبت‌شده در RIFF نباید از فایل واقعی بزرگ‌تر باشد.
  if (declared + 8 > buffer.length) throw intakeError('فایل WebP ناقص است.');

  const simple = buffer.subarray(12, 16).toString('latin1');
  if (simple === 'VP8 ' || simple === 'VP8L') {
    // قالب سادهٔ WebP اصلاً بخش متادیتا ندارد؛ فقط ابعاد کنترل می‌شود.
    const { width, height } = simpleWebpDimensions(buffer, simple);
    assertDimensions(width, height);
    return { buffer: buffer.subarray(0, declared + 8), width, height };
  }
  if (simple !== 'VP8X') throw intakeError('این فایل تصویر WebP معتبری نیست.');

  const chunks = [];
  let offset = 12;
  let width = 0;
  let height = 0;
  let sawImage = false;
  let vp8xData = null;

  while (offset + 8 <= declared + 8) {
    const type = buffer.subarray(offset, offset + 4).toString('latin1');
    const size = buffer.readUInt32LE(offset + 4);
    // هر بخش RIFF تا مرز زوج پر می‌شود.
    const padded = size + (size % 2);
    const end = offset + 8 + padded;
    if (end > buffer.length) throw intakeError('فایل WebP ناقص است.');

    if (type === 'VP8X') {
      if (size < 10) throw intakeError('سرآیند WebP ناقص است.');
      vp8xData = Buffer.from(buffer.subarray(offset + 8, offset + 8 + size));
      width = ((vp8xData[4] | (vp8xData[5] << 8) | (vp8xData[6] << 16)) >>> 0) + 1;
      height = ((vp8xData[7] | (vp8xData[8] << 8) | (vp8xData[9] << 16)) >>> 0) + 1;
      // بیت‌های EXIF (0x08) و XMP (0x04) پس از حذف بخش‌ها باید خاموش شوند.
      vp8xData[0] &= ~0x0c;
      chunks.push({ type, header: buffer.subarray(offset, offset + 8), body: vp8xData, padded });
    } else if (!WEBP_STRIPPED.has(type)) {
      if (['VP8 ', 'VP8L', 'ANMF'].includes(type)) sawImage = true;
      chunks.push({ type, raw: buffer.subarray(offset, end) });
    }
    offset = end;
  }

  if (!vp8xData || !sawImage) throw intakeError('این فایل تصویر WebP معتبری نیست.');
  assertDimensions(width, height);

  const body = Buffer.concat(chunks.map((chunk) => {
    if (chunk.raw) return chunk.raw;
    const padding = chunk.padded - chunk.body.length;
    return Buffer.concat([chunk.header, chunk.body, Buffer.alloc(padding)]);
  }));
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return { buffer: Buffer.concat([header, body]), width, height };
}

function simpleWebpDimensions(buffer, kind) {
  try {
    if (kind === 'VP8 ') {
      // سرآیند قاب کلیدی VP8: سه بایت tag، سه بایت امضا، سپس عرض و ارتفاع ۱۴ بیتی.
      const start = 20 + 3;
      return { width: buffer.readUInt16LE(start) & 0x3fff, height: buffer.readUInt16LE(start + 2) & 0x3fff };
    }
    // VP8L: یک بایت امضا، سپس عرض−۱ و ارتفاع−۱ در ۱۴ بیت پشت سر هم.
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  } catch { return { width: 0, height: 0 }; }
}

// ---------------------------------------------------------------------------

/**
 * تصویر رسید را می‌پذیرد یا با خطای روشن رد می‌کند.
 * خروجی همیشه بایت پاک‌سازی‌شده و نوعِ خوانده‌شده از خود فایل است؛ برچسب
 * کلاینت فقط برای پیام خطا به کار می‌رود و هرگز ذخیره نمی‌شود.
 */
export function acceptReceiptImage(buffer, declaredType = '') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw intakeError('فایل تصویر دریافت نشد.');
  const detected = detectImageType(buffer);
  if (!detected) throw intakeError('یک تصویر JPG، PNG یا WebP انتخاب کن؛ محتوای این فایل تصویر نیست.', 'RECEIPT_IMAGE_UNSUPPORTED');

  const normalizedDeclared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  const declaredMismatch = Boolean(normalizedDeclared)
    && SUPPORTED_RECEIPT_TYPES.includes(normalizedDeclared)
    && normalizedDeclared !== detected;

  const sanitized = detected === 'image/jpeg' ? sanitizeJpeg(buffer)
    : detected === 'image/png' ? sanitizePng(buffer)
      : sanitizeWebp(buffer);

  return {
    buffer: sanitized.buffer,
    mimeType: detected,
    width: sanitized.width,
    height: sanitized.height,
    declaredMismatch,
    bytesRemoved: buffer.length - sanitized.buffer.length,
  };
}
