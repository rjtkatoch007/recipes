import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from "url";
import { query, pool, connectDB } from './db.js';
import { auth, admin, ownerOrAdmin } from './middleware.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

dotenv.config();
const app=express();
app.use(helmet());
app.use(cors({origin:process.env.CORS_ORIGIN?.split(',')||true}));
app.use(express.json({limit:'2mb'}));
app.use('/api',rateLimit({windowMs:15*60*1000,limit:300}));
//const docs=YAML.load(new URL('../openapi.yaml',import.meta.url).pathname);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const swaggerDocument = YAML.load(
  path.resolve(__dirname, "../openapi.yaml")
);
app.use('/api-docs',swaggerUi.serve,swaggerUi.setup(swaggerDocument));
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const idSchema=z.string().uuid();
const userSafe='id,name,email,bio,avatar_url,role,created_at';
const recipeSelect=`r.*,u.name AS author_name,(SELECT round(avg(rating)::numeric,1) FROM reviews WHERE recipe_id=r.id) AS average_rating,(SELECT count(*) FROM reviews WHERE recipe_id=r.id) AS review_count`;
const s3=process.env.AWS_S3_BUCKET?new S3Client({region:process.env.AWS_REGION}):null;

// Auth
app.post('/api/auth/register',wrap(async(req,res)=>{
 const data=z.object({name:z.string().min(2).max(100),email:z.string().email(),password:z.string().min(8)}).parse(req.body);
 const hash=await bcrypt.hash(data.password,12);
 const {rows}=await query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,role,status,bio,avatar_url',[data.name,data.email.toLowerCase(),hash]);
 const token=jwt.sign({sub:rows[0].id},process.env.JWT_SECRET,{expiresIn:process.env.JWT_EXPIRES_IN||'7d'});
 res.status(201).json({user:rows[0],token});
}));
app.post('/api/auth/login',wrap(async(req,res)=>{
 const d=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body);
 const {rows}=await query('SELECT * FROM users WHERE email=$1',[d.email.toLowerCase()]);
 if(!rows[0]||!(await bcrypt.compare(d.password,rows[0].password_hash))) return res.status(401).json({error:'Invalid email or password'});
 if(rows[0].status!=='active') return res.status(403).json({error:'Account is not active'});
 const token=jwt.sign({sub:rows[0].id},process.env.JWT_SECRET,{expiresIn:process.env.JWT_EXPIRES_IN||'7d'});
 const {password_hash,...user}=rows[0]; res.json({user,token});
}));
app.get('/api/auth/me',auth(),(req,res)=>res.json({user:req.user}));

// Profiles and social
app.get('/api/users/:id',wrap(async(req,res)=>{
 const {rows}=await query(`SELECT id,name,bio,avatar_url,created_at,(SELECT count(*) FROM recipes WHERE user_id=users.id AND status='published') recipe_count,(SELECT count(*) FROM follows WHERE following_id=users.id) follower_count,(SELECT count(*) FROM follows WHERE follower_id=users.id) following_count FROM users WHERE id=$1 AND status='active'`,[req.params.id]);
 if(!rows[0])return res.status(404).json({error:'User not found'});res.json(rows[0]);
}));
app.patch('/api/users/me',auth(),wrap(async(req,res)=>{
 const d=z.object({name:z.string().min(2).max(100).optional(),bio:z.string().max(1000).optional(),avatar_url:z.string().url().optional()}).parse(req.body);
 const {rows}=await query('UPDATE users SET name=COALESCE($1,name),bio=COALESCE($2,bio),avatar_url=COALESCE($3,avatar_url),updated_at=now() WHERE id=$4 RETURNING id,name,email,bio,avatar_url,role',[d.name,d.bio,d.avatar_url,req.user.id]);res.json(rows[0]);
}));
app.get('/api/users/me/recipes',auth(),wrap(async(req,res)=>{const {rows}=await query(`SELECT ${recipeSelect} FROM recipes r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1 ORDER BY r.created_at DESC`,[req.user.id]);res.json(rows)}));
app.get('/api/users/:id/recipes',wrap(async(req,res)=>{const {rows}=await query(`SELECT ${recipeSelect} FROM recipes r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1 AND r.status='published' ORDER BY r.created_at DESC`,[req.params.id]);res.json(rows)}));
app.post('/api/users/:id/follow',auth(),wrap(async(req,res)=>{if(req.params.id===req.user.id)return res.status(400).json({error:'Cannot follow yourself'});await query('INSERT INTO follows(follower_id,following_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,req.params.id]);res.status(201).json({following:true})}));
app.delete('/api/users/:id/follow',auth(),wrap(async(req,res)=>{await query('DELETE FROM follows WHERE follower_id=$1 AND following_id=$2',[req.user.id,req.params.id]);res.json({following:false})}));

// Recipes browse/search/filter and CRUD
app.get('/api/recipes',wrap(async(req,res)=>{
 const {q,ingredient,category,dietary,difficulty,max_time,limit='20',offset='0'}=req.query;
 const vals=[]; const where=[`r.status='published'`];
 const add=(sql,v)=>{vals.push(v);where.push(sql.replace('?',`$${vals.length}`))};
 if(q)add(`to_tsvector('english',r.title||' '||coalesce(r.description,'')) @@ plainto_tsquery('english',?)`,q);
 if(ingredient)add(`EXISTS(SELECT 1 FROM recipe_ingredients ri JOIN ingredients i ON i.id=ri.ingredient_id WHERE ri.recipe_id=r.id AND i.name ILIKE '%'||?||'%')`,ingredient);
 if(category)add(`EXISTS(SELECT 1 FROM recipe_categories rc JOIN categories c ON c.id=rc.category_id WHERE rc.recipe_id=r.id AND c.name ILIKE ?)`,`%${category}%`);
 if(dietary)add(`? = ANY(r.dietary)`,dietary);
 if(difficulty)add(`r.difficulty=?`,difficulty);
 if(max_time)add(`(r.prep_time+r.cooking_time)<=?`,Number(max_time));
 vals.push(Math.min(100,Math.max(1,Number(limit)||20)));const l=vals.length;vals.push(Math.max(0,Number(offset)||0));const o=vals.length;
 const {rows}=await query(`SELECT ${recipeSelect} FROM recipes r JOIN users u ON u.id=r.user_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT $${l} OFFSET $${o}`,vals);res.json({items:rows,limit:vals[l-1],offset:vals[o-1]});
}));
app.get('/api/recipes/:id',wrap(async(req,res)=>{const {rows}=await query(`SELECT ${recipeSelect} FROM recipes r JOIN users u ON u.id=r.user_id WHERE r.id=$1 AND r.status='published'`,[req.params.id]);if(!rows[0])return res.status(404).json({error:'Recipe not found'});const ing=await query('SELECT i.name,ri.quantity FROM recipe_ingredients ri JOIN ingredients i ON i.id=ri.ingredient_id WHERE ri.recipe_id=$1',[req.params.id]);res.json({...rows[0],ingredients:ing.rows})}));
app.post('/api/recipes',auth(),wrap(async(req,res)=>{
 const d=z.object({title:z.string().min(3).max(180),description:z.string().max(3000).optional(),instructions:z.array(z.string().min(1)).min(1),prep_time:z.number().int().min(0),cooking_time:z.number().int().min(0),servings:z.number().int().min(1),difficulty:z.enum(['easy','medium','hard']),dietary:z.array(z.string()).optional(),ingredients:z.array(z.object({name:z.string().min(1),quantity:z.string().optional()})).min(1),categories:z.array(z.string()).optional(),image_url:z.string().url().optional()}).parse(req.body);
 const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query(`INSERT INTO recipes(user_id,title,description,instructions,prep_time,cooking_time,servings,difficulty,dietary,image_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[req.user.id,d.title,d.description||'',JSON.stringify(d.instructions),d.prep_time,d.cooking_time,d.servings,d.difficulty,d.dietary||[],d.image_url||null]);
 for(const x of d.ingredients){const i=await c.query('INSERT INTO ingredients(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id',[x.name.trim().toLowerCase()]);await c.query('INSERT INTO recipe_ingredients(recipe_id,ingredient_id,quantity) VALUES($1,$2,$3)',[r.rows[0].id,i.rows[0].id,x.quantity||'']);}
 for(const name of d.categories||[]){const cat=await c.query('INSERT INTO categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id',[name]);await c.query('INSERT INTO recipe_categories(recipe_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[r.rows[0].id,cat.rows[0].id]);}
 await c.query("INSERT INTO activities(user_id,type,recipe_id) VALUES($1,'recipe_created',$2)",[req.user.id,r.rows[0].id]);await c.query('COMMIT');res.status(201).json(r.rows[0]);
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
app.patch('/api/recipes/:id',auth(),wrap(async(req,res)=>{const d=z.object({title:z.string().min(3).max(180).optional(),description:z.string().max(3000).optional(),instructions:z.array(z.string()).optional(),prep_time:z.number().int().min(0).optional(),cooking_time:z.number().int().min(0).optional(),servings:z.number().int().min(1).optional(),difficulty:z.enum(['easy','medium','hard']).optional(),dietary:z.array(z.string()).optional(),image_url:z.string().url().optional()}).parse(req.body);const old=await query('SELECT user_id FROM recipes WHERE id=$1',[req.params.id]);if(!old.rows[0])return res.status(404).json({error:'Recipe not found'});if(!ownerOrAdmin(old.rows[0].user_id,req))return res.status(403).json({error:'Not your recipe'});const keys=Object.keys(d);if(!keys.length)return res.status(400).json({error:'No fields supplied'});const cols={title:'title',description:'description',instructions:'instructions',prep_time:'prep_time',cooking_time:'cooking_time',servings:'servings',difficulty:'difficulty',dietary:'dietary',image_url:'image_url'};const sets=keys.map((k,i)=>`${cols[k]}=$${i+1}`);const vals=keys.map(k=>k==='instructions'?JSON.stringify(d[k]):d[k]);vals.push(req.params.id);const {rows}=await query(`UPDATE recipes SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);res.json(rows[0])}));
app.delete('/api/recipes/:id',auth(),wrap(async(req,res)=>{const old=await query('SELECT user_id FROM recipes WHERE id=$1',[req.params.id]);if(!old.rows[0])return res.status(404).json({error:'Recipe not found'});if(!ownerOrAdmin(old.rows[0].user_id,req))return res.status(403).json({error:'Not your recipe'});await query('DELETE FROM recipes WHERE id=$1',[req.params.id]);res.json({deleted:true})}));

// Favorites
app.get('/api/favorites',auth(),wrap(async(req,res)=>{const {rows}=await query(`SELECT ${recipeSelect} FROM favorites f JOIN recipes r ON r.id=f.recipe_id JOIN users u ON u.id=r.user_id WHERE f.user_id=$1 ORDER BY f.created_at DESC`,[req.user.id]);res.json(rows)}));
app.post('/api/favorites/:recipeId',auth(),wrap(async(req,res)=>{await query('INSERT INTO favorites(user_id,recipe_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,req.params.recipeId]);res.status(201).json({saved:true})}));
app.delete('/api/favorites/:recipeId',auth(),wrap(async(req,res)=>{await query('DELETE FROM favorites WHERE user_id=$1 AND recipe_id=$2',[req.user.id,req.params.recipeId]);res.json({saved:false})}));

// Collections
app.get('/api/collections',auth(),wrap(async(req,res)=>{const {rows}=await query('SELECT * FROM collections WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]);res.json(rows)}));
app.post('/api/collections',auth(),wrap(async(req,res)=>{const d=z.object({name:z.string().min(1).max(100),description:z.string().max(500).optional()}).parse(req.body);const {rows}=await query('INSERT INTO collections(user_id,name,description) VALUES($1,$2,$3) RETURNING *',[req.user.id,d.name,d.description||'']);res.status(201).json(rows[0])}));
app.delete('/api/collections/:id',auth(),wrap(async(req,res)=>{const {rowCount}=await query('DELETE FROM collections WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);if(!rowCount)return res.status(404).json({error:'Collection not found'});res.json({deleted:true})}));
app.post('/api/collections/:id/recipes/:recipeId',auth(),wrap(async(req,res)=>{const c=await query('SELECT id FROM collections WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);if(!c.rows[0])return res.status(404).json({error:'Collection not found'});await query('INSERT INTO collection_recipes(collection_id,recipe_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.params.id,req.params.recipeId]);res.status(201).json({added:true})}));
app.delete('/api/collections/:id/recipes/:recipeId',auth(),wrap(async(req,res)=>{await query('DELETE FROM collection_recipes cr USING collections c WHERE cr.collection_id=c.id AND c.user_id=$1 AND c.id=$2 AND cr.recipe_id=$3',[req.user.id,req.params.id,req.params.recipeId]);res.json({removed:true})}));
app.get('/api/collections/:id/recipes',auth(),wrap(async(req,res)=>{const {rows}=await query(`SELECT ${recipeSelect} FROM collection_recipes cr JOIN collections c ON c.id=cr.collection_id JOIN recipes r ON r.id=cr.recipe_id JOIN users u ON u.id=r.user_id WHERE c.id=$1 AND c.user_id=$2`,[req.params.id,req.user.id]);res.json(rows)}));

// Reviews
app.get('/api/recipes/:id/reviews',wrap(async(req,res)=>{const {rows}=await query('SELECT rv.*,u.name AS reviewer_name FROM reviews rv JOIN users u ON u.id=rv.user_id WHERE recipe_id=$1 ORDER BY created_at DESC',[req.params.id]);res.json(rows)}));
app.post('/api/recipes/:id/reviews',auth(),wrap(async(req,res)=>{const d=z.object({rating:z.number().int().min(1).max(5),comment:z.string().max(2000).optional()}).parse(req.body);const {rows}=await query(`INSERT INTO reviews(user_id,recipe_id,rating,comment) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,recipe_id) DO UPDATE SET rating=EXCLUDED.rating,comment=EXCLUDED.comment,updated_at=now() RETURNING *`,[req.user.id,req.params.id,d.rating,d.comment||'']);await query("INSERT INTO activities(user_id,type,recipe_id,review_id) VALUES($1,'review_created',$2,$3)",[req.user.id,req.params.id,rows[0].id]);res.status(201).json(rows[0])}));
app.delete('/api/reviews/:id',auth(),wrap(async(req,res)=>{const r=await query('SELECT user_id FROM reviews WHERE id=$1',[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Review not found'});if(!ownerOrAdmin(r.rows[0].user_id,req))return res.status(403).json({error:'Not your review'});await query('DELETE FROM reviews WHERE id=$1',[req.params.id]);res.json({deleted:true})}));

// Feed
app.get('/api/feed',auth(),wrap(async(req,res)=>{const {rows}=await query(`SELECT a.*,u.name AS actor_name,r.title AS recipe_title FROM activities a JOIN follows f ON f.following_id=a.user_id JOIN users u ON u.id=a.user_id LEFT JOIN recipes r ON r.id=a.recipe_id WHERE f.follower_id=$1 ORDER BY a.created_at DESC LIMIT 50`,[req.user.id]);res.json(rows)}));

// S3 image upload: server receives file and stores it privately; return short-lived URL
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))});
app.post('/api/recipes/image',auth(),upload.single('image'),wrap(async(req,res)=>{if(!req.file)return res.status(400).json({error:'Image file required (JPEG, PNG, WEBP or GIF)'});if(!s3)return res.status(503).json({error:'S3 is not configured'});const key=`recipes/${req.user.id}/${crypto.randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`;await s3.send(new PutObjectCommand({Bucket:process.env.AWS_S3_BUCKET,Key:key,Body:req.file.buffer,ContentType:req.file.mimetype}));const url=await getSignedUrl(s3,new (await import('@aws-sdk/client-s3')).GetObjectCommand({Bucket:process.env.AWS_S3_BUCKET,Key:key}),{expiresIn:3600});res.status(201).json({key,url,expires_in:3600})}));

// Admin
app.get('/api/admin/users',auth(),admin,wrap(async(req,res)=>{const {rows}=await query('SELECT id,name,email,role,status,created_at FROM users ORDER BY created_at DESC LIMIT 200');res.json(rows)}));
app.patch('/api/admin/users/:id/status',auth(),admin,wrap(async(req,res)=>{const d=z.object({status:z.enum(['active','banned','pending'])}).parse(req.body);const {rows}=await query('UPDATE users SET status=$1,updated_at=now() WHERE id=$2 RETURNING id,name,email,status',[d.status,req.params.id]);if(!rows[0])return res.status(404).json({error:'User not found'});res.json(rows[0])}));
app.get('/api/admin/recipes',auth(),admin,wrap(async(req,res)=>{const {rows}=await query('SELECT r.id,r.title,r.status,r.created_at,u.name author_name FROM recipes r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 200');res.json(rows)}));
app.patch('/api/admin/recipes/:id/status',auth(),admin,wrap(async(req,res)=>{const d=z.object({status:z.enum(['published','hidden','pending'])}).parse(req.body);const {rows}=await query('UPDATE recipes SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[d.status,req.params.id]);if(!rows[0])return res.status(404).json({error:'Recipe not found'});res.json(rows[0])}));

app.use((err,req,res,next)=>{if(err instanceof z.ZodError)return res.status(400).json({error:'Validation failed',details:err.issues});if(err.code==='23505')return res.status(409).json({error:'Resource already exists'});console.error(err);res.status(500).json({error:'Internal server error'});});

const port = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // First connect to PostgreSQL
    await connectDB();

    // Start Express after successful DB connection
    app.listen(port, () => {
      console.log(
        `Recipe API listening on http://localhost:${port}`
      );
    });

  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
};

startServer();

