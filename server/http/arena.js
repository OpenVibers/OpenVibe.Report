'use strict';
const express=require('express');const views=require('../views');
function createArenaRoutes({config,fetchImpl=globalThis.fetch}){
 const r=express.Router();r.use(express.urlencoded({extended:false,limit:'64kb'}));
 r.all(['/ai/arena','/ai/arena/:id','/ai/arena/:id/vote'],async(req,res,next)=>{
  if(!['GET','POST'].includes(req.method))return next();
  res.set('Cache-Control','no-store');
  if(req.method==='POST'&&(!req.user||!req.token))return res.redirect(303,'/auth/login?next='+encodeURIComponent(req.originalUrl));
  if(req.method==='POST'&&req.get('origin')!==new URL(config.baseUrl).origin)return res.sendStatus(403);
  let path='/rounds';if(req.params.id)path+='/'+encodeURIComponent(req.params.id);if(req.path.endsWith('/vote'))path+='/votes';
  try{
   const upstream=await fetchImpl('https://openvibe.exchange/api/v1/arena'+path,{method:req.method,headers:{...(req.token?{authorization:'Bearer '+req.token}:{}),'content-type':'application/json'},...(req.method==='POST'?{body:JSON.stringify(req.body)}:{}),redirect:'error',signal:AbortSignal.timeout(120000)});
   const data=await upstream.json();
   if(data.location&&/^\/ai\/arena(?:\/[a-zA-Z0-9_-]+)?$/.test(data.location))return res.redirect(303,data.location);
   // The Exchange renders escaped Arena fragments with its existing private-round access and Bench vote rules.
   const body=typeof data.html==='string'?data.html.replace(/(href|action)="\/arena\/ask"/g,'$1="/ai/arena"').replace(/(href|action)="\/arena/g,'$1="/ai/arena').replace(/href="\/rankings/g,'href="/ai').replace(/next=%2Farena/g,'next=%2Fai%2Farena'):'<p>The Arena is unavailable. Try again shortly.</p>';
   return res.status(upstream.status).type('html').send(views.layout({title:'The Arena',path:req.path,active:'/ai',robots:'noindex, nofollow',body:'<link rel="stylesheet" href="/css/arena.css">'+body}));
  }catch{return res.status(502).type('html').send(views.layout({title:'The Arena',path:req.path,active:'/ai',body:'<p>The Arena could not answer. Please try again.</p>'}));}
 });return r;
}
module.exports={createArenaRoutes};
