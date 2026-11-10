/* Seed the database with the curriculum, demo accounts and a realistic class history.

    npm run seed                  # create tables + seed (refuses if data exists)
    npm run seed -- --reset       # drop everything and seed again
*/
import { closeDb } from '../db.ts';
import { run } from './seed.ts';

await run(process.argv.includes('--reset'));
await closeDb();
