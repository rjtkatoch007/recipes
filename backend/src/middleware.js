import jwt from 'jsonwebtoken';
import { query } from './db.js';
export function auth(required=true) {
 return async (req,res,next) => {
  const token=(req.headers.authorization||'').replace(/^Bearer /,'');
  if(!token){ if(!required) return next(); return res.status(401).json({error:'Authentication required'}); }
  try {
   const payload=jwt.verify(token,process.env.JWT_SECRET);
   const {rows}=await query('SELECT id,name,email,role,status,bio,avatar_url FROM users WHERE id=$1',[payload.sub]);
   if(!rows[0] || rows[0].status!=='active') return res.status(401).json({error:'Account unavailable'});
   req.user=rows[0]; next();
  } catch(e){ return res.status(401).json({error:'Invalid or expired token'}); }
 };
}
export const admin=(req,res,next)=> req.user?.role==='admin' ? next() : res.status(403).json({error:'Admin access required'});
export const ownerOrAdmin=(userId,req)=>req.user?.role==='admin'||req.user?.id===userId;
