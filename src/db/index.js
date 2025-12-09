import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/calq';

// Connection for queries (pooled)
const queryClient = postgres(connectionString, { max: 10 });

// Export the drizzle instance with schema
export const db = drizzle(queryClient, { schema });

// Export schema for use in queries
export * from './schema.js';
