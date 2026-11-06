CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name VARCHAR(100) NOT NULL,
 email VARCHAR(255) UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 bio TEXT DEFAULT '',
 avatar_url TEXT,
 role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
 status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned','pending')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recipes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title VARCHAR(180) NOT NULL,
 description TEXT DEFAULT '',
 instructions JSONB NOT NULL DEFAULT '[]',
 cooking_time INTEGER NOT NULL DEFAULT 0 CHECK(cooking_time >= 0),
 prep_time INTEGER NOT NULL DEFAULT 0 CHECK(prep_time >= 0),
 servings INTEGER NOT NULL DEFAULT 1 CHECK(servings > 0),
 difficulty VARCHAR(20) NOT NULL DEFAULT 'easy' CHECK(difficulty IN ('easy','medium','hard')),
 dietary TEXT[] NOT NULL DEFAULT '{}',
 image_url TEXT,
 status VARCHAR(20) NOT NULL DEFAULT 'published' CHECK(status IN ('published','hidden','pending')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ingredients (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name VARCHAR(150) UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_ingredients (
 recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
 ingredient_id UUID REFERENCES ingredients(id) ON DELETE CASCADE,
 quantity VARCHAR(100) DEFAULT '',
 PRIMARY KEY(recipe_id, ingredient_id)
);
CREATE TABLE IF NOT EXISTS categories (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name VARCHAR(80) UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_categories (
 recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
 category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
 PRIMARY KEY(recipe_id, category_id)
);
CREATE TABLE IF NOT EXISTS favorites (
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ DEFAULT now(),
 PRIMARY KEY(user_id, recipe_id)
);
CREATE TABLE IF NOT EXISTS collections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name VARCHAR(100) NOT NULL,
 description TEXT DEFAULT '',
 created_at TIMESTAMPTZ DEFAULT now(),
 UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS collection_recipes (
 collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
 recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
 PRIMARY KEY(collection_id, recipe_id)
);
CREATE TABLE IF NOT EXISTS reviews (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment TEXT DEFAULT '',
 created_at TIMESTAMPTZ DEFAULT now(),
 updated_at TIMESTAMPTZ DEFAULT now(),
 UNIQUE(user_id, recipe_id)
);
CREATE TABLE IF NOT EXISTS follows (
 follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
 following_id UUID REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ DEFAULT now(),
 PRIMARY KEY(follower_id, following_id),
 CHECK(follower_id <> following_id)
);
CREATE TABLE IF NOT EXISTS activities (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 type VARCHAR(40) NOT NULL,
 recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
 review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recipes_created_idx ON recipes(created_at DESC);
CREATE INDEX IF NOT EXISTS recipes_dietary_idx ON recipes USING GIN(dietary);
CREATE INDEX IF NOT EXISTS recipes_search_idx ON recipes USING GIN(to_tsvector('english', title || ' ' || coalesce(description,'')));
CREATE INDEX IF NOT EXISTS activities_created_idx ON activities(created_at DESC);
