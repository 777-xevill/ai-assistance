import { defineConfig } from 'drizzle-kit';

// Only used to generate SQL migrations (`npm run db:generate`).
// Migrations are applied automatically when the server starts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
