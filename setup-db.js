import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Client } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setupDatabase() {
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error('Error: DATABASE_URL environment variable is not set.');
    console.log('\nPlease provide your Supabase connection string. You can find it at:');
    console.log('Supabase Dashboard -> Project Settings -> Database -> Connection string (URI)');
    console.log('\nUsage: DATABASE_URL="postgresql://postgres.[ref]:[password]@..." node setup-db.js');
    process.exit(1);
  }

  const client = new Client({
    connectionString: dbUrl,
  });

  try {
    console.log('Connecting to the database...');
    await client.connect();
    
    const sqlPath = path.join(__dirname, 'ALL-IN-ONE-database-setup.sql');
    console.log(`Reading SQL file from ${sqlPath}...`);
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Executing SQL script. This might take a moment...');
    await client.query(sql);
    
    console.log('✅ Database setup completed successfully!');
  } catch (error) {
    console.error('❌ Error executing database setup:', error);
  } finally {
    await client.end();
  }
}

setupDatabase();
