import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

// Check PostgreSQL connection
export const connectDB = async () => {
  try {
    const client = await pool.connect();

    console.log('PostgreSQL Database Connected Successfully!');

    const result = await client.query('SELECT NOW()');

    console.log('Database Server Time:', result.rows[0].now);

    client.release();

  } catch (error) {
    console.error('PostgreSQL Database Connection Failed:', error);
    throw error;
  }
};

// Reusable query function
export const query = (text, params) => {
  return pool.query(text, params);
};
