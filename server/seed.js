import { seedDemo } from './db.js';
const count = seedDemo();
console.log(count ? `${count} demo transactions added.` : 'Database already contains transactions; nothing changed.');
