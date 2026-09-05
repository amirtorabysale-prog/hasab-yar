import fs from 'node:fs';
const [file, oldPath, newPath] = process.argv.slice(2);
const s = fs.readFileSync(file, 'utf8');
const crlf = s.includes('\r\n');
const norm = (t) => (crlf ? t.replace(/\r?\n/g, '\r\n') : t.replace(/\r\n/g, '\n'));
const oldText = norm(fs.readFileSync(oldPath, 'utf8').replace(/\r?\n$/, ''));
const newText = norm(fs.readFileSync(newPath, 'utf8').replace(/\r?\n$/, ''));
const count = s.split(oldText).length - 1;
if (count !== 1) { console.error(`match count = ${count}`); process.exit(1); }
fs.writeFileSync(file, s.replace(oldText, newText));
console.log('ok');
