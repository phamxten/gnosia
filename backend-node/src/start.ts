/* One entry file for hosts that run a single command (Hostinger Node.js web apps, Heroku-style platforms):
   create the tables and seed the demo data when the database is empty, then start the server. */
import { run } from './seed/seed.ts';

await run(false);
await import('./main.ts');
