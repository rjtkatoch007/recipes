# Recipe Management & Sharing Platform

Backend-first full-stack starter: Express + PostgreSQL + JWT + optional AWS S3, with a React demo client and Swagger API docs.

## Requirements
- Node.js 20+
- PostgreSQL 14+
- npm

## Setup
1. Create a PostgreSQL database (for example `recipe_platform`).
2. Copy `backend/.env.example` to `backend/.env` and configure `DATABASE_URL`, `JWT_SECRET`.
3. Run the schema: `psql "$DATABASE_URL" -f backend/sql/schema.sql`
4. Backend: `cd backend && npm install && npm run dev`
5. Frontend: in another terminal, `cd frontend && npm install && npm run dev`
6. Open the Vite URL (normally http://localhost:5173). Swagger is at http://localhost:3000/api-docs.

AWS S3 is optional for local development. Without S3 credentials, recipe image upload returns a clear configuration error; other APIs work normally.

## Roles and authorization
New accounts are `user` by default. Promote an administrator directly in PostgreSQL:
`UPDATE users SET role='admin' WHERE email='you@example.com';`
Never expose this operation through public registration.

## Main API groups
- `/api/auth` registration, login, current user
- `/api/users` profiles, contributed/favorite recipes, follow/unfollow
- `/api/recipes` CRUD, browse, search and filters, image upload
- `/api/favorites` save/remove/list
- `/api/collections` collection CRUD and recipe membership
- `/api/recipes/:id/reviews` ratings and reviews
- `/api/feed` followed-user activity
- `/api/admin` user and recipe moderation

All protected endpoints require `Authorization: Bearer <JWT>`. See Swagger for request/response details.

## Notes
- Passwords are hashed with bcrypt.
- JWT secrets must be long, random and private.
- Input validation and ownership checks are enforced in the API.
- Recipe search uses PostgreSQL full-text search plus ingredient/category filters.
- For production, add HTTPS, rate limiting, email verification/password reset, migrations, backups, monitoring, and S3 bucket policy/CloudFront as appropriate.
