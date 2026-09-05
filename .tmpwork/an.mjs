import fs from 'node:fs';
import { readParsianTemplate } from '../server/parsianAccessFile.js';
const buf = fs.readFileSync('parsian/parsian-document-export.mdb');
const t = readParsianTemplate(buf);
console.log('tdefPage', t.tdefPage, 'dataPages', t.dataPages, 'indexPage', t.indexPage, 'rowCount', t.rowCount, 'pageCount', t.pageCount);
const P=4096;
for (let p=0;p<t.pageCount;p++){
  const o=p*P;
  if (buf.readInt32LE(o+4)===t.tdefPage) console.log('owned page', p, 'type 0x'+buf[o].toString(16));
}
const base=t.tdefPage*P;
console.log('numIdx@47', buf.readInt32LE(base+47), 'numRealIdx@51', buf.readInt32LE(base+51));
console.log('TDEF head', buf.subarray(base, base+64).toString('hex'));
const ip=t.indexPage*P;
console.log('index page head', buf.subarray(ip, ip+32).toString('hex'));
console.log('prev', buf.readInt32LE(ip+8), 'next', buf.readInt32LE(ip+12), 'tail?', buf.readInt32LE(ip+16));
