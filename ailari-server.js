// Ailari Backend v3.0 — 5 IAs opcionales
// npm install express cors dotenv express-rate-limit uuid better-sqlite3

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';
import { readFileSync } from 'fs';
import { v4 as uuid } from 'uuid';

// ── KEYS — todas opcionales menos CLIENT_KEY ──
const GROQ_KEY       = process.env.GROQ_API_KEY;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const CLAUDE_KEY     = process.env.ANTHROPIC_API_KEY;
const GPT_KEY        = process.env.OPENAI_API_KEY;
const CLIENT_KEY     = process.env.CLIENT_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const DEV_MODE       = process.env.ALLOW_INSECURE_DEV === 'true';
const CORE_FILE      = process.env.CORE_FILE || 'ailari_core.json';
const TIMEOUT        = 20000;
const AUTH_ENABLED   = !!CLIENT_KEY;

// IAs disponibles según keys configuradas
const IAS = {
  groq:       { available: !!GROQ_KEY,       nombre: 'Groq (Llama)' },
  gemini:     { available: !!GEMINI_KEY,      nombre: 'Gemini' },
  perplexity: { available: !!PERPLEXITY_KEY,  nombre: 'Perplexity' },
  claude:     { available: !!CLAUDE_KEY,      nombre: 'Claude' },
  gpt:        { available: !!GPT_KEY,         nombre: 'GPT-4o' },
};

const availableIAs = Object.entries(IAS).filter(([,v])=>v.available).map(([k])=>k);
const HAS_DEEP = availableIAs.length >= 2; // deep necesita al menos 2 IAs

// Arranque seguro
if (!DEV_MODE) {
  const missing = [];
  if (!CLIENT_KEY)     missing.push('CLIENT_KEY');
  if (!ALLOWED_ORIGIN) missing.push('ALLOWED_ORIGIN');
  if (availableIAs.length === 0) missing.push('al menos una API key de IA');
  if (missing.length) {
    console.error(`❌ Variables requeridas faltantes: ${missing.join(', ')}`);
    console.error('   Para dev local: ALLOW_INSECURE_DEV=true');
    process.exit(1);
  }
} else {
  console.warn('⚠️  MODO DEV INSEGURO — no usar en producción');
  if (availableIAs.length === 0) { console.error('❌ Necesitas al menos una API key'); process.exit(1); }
}

console.log(`✅ IAs disponibles: ${availableIAs.map(k=>IAS[k].nombre).join(', ')}`);
console.log(`✅ Modo profundo: ${HAS_DEEP ? 'activo' : 'inactivo (necesita 2+ IAs)'}`);

// ── SQLITE con fallback JSON ──
let insertChat, getChats, insertMem, getMem, getAllMem, getHealthStats;
try {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database('ailari.db');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY, mensaje TEXT NOT NULL, respuesta TEXT NOT NULL,
      modo TEXT NOT NULL, ia_usada TEXT DEFAULT '', memoria_usada TEXT DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY, texto TEXT NOT NULL, tags TEXT DEFAULT '[]',
      tipo TEXT DEFAULT 'aprendizaje', pregunta TEXT, decision TEXT,
      ia_origen TEXT DEFAULT '', chat_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at DESC);
  `);
  insertChat     = db.prepare(`INSERT INTO chats (id,mensaje,respuesta,modo,ia_usada,memoria_usada,created_at) VALUES (@id,@mensaje,@respuesta,@modo,@ia_usada,@memoria_usada,@created_at)`);
  getChats       = db.prepare(`SELECT * FROM chats ORDER BY created_at DESC LIMIT ?`);
  insertMem      = db.prepare(`INSERT INTO memory (id,texto,tags,tipo,pregunta,decision,ia_origen,chat_id,created_at) VALUES (@id,@texto,@tags,@tipo,@pregunta,@decision,@ia_origen,@chat_id,@created_at)`);
  getMem         = db.prepare(`SELECT * FROM memory ORDER BY created_at DESC LIMIT ?`);
  getAllMem      = db.prepare(`SELECT * FROM memory ORDER BY created_at DESC`);
  getHealthStats = () => ({
    chats: db.prepare('SELECT COUNT(*) as n FROM chats').get().n,
    memories: db.prepare('SELECT COUNT(*) as n FROM memory').get().n
  });
  console.log('✅ SQLite activo');
} catch(e) {
  console.warn('⚠️  SQLite no disponible, usando JSON:', e.message);
  const { readFileSync: rfs, writeFileSync: wfs } = await import('fs');
  const CF = 'chats.json', MF = 'memory.json';
  const lj = f => { try { return JSON.parse(rfs(f,'utf-8')); } catch { return []; } };
  const sj = (f,d) => wfs(f,JSON.stringify(d,null,2));
  insertChat     = r => { const a=lj(CF); a.unshift(r); if(a.length>200)a.pop(); sj(CF,a); };
  getChats       = n => lj(CF).slice(0,n);
  insertMem      = r => { const a=lj(MF); a.unshift(r); if(a.length>500)a.pop(); sj(MF,a); };
  getMem         = n => lj(MF).slice(0,n);
  getAllMem      = () => lj(MF);
  getHealthStats = () => ({ chats:lj(CF).length, memories:lj(MF).length });
}

// ── EXPRESS ──
const app = express();
app.use(cors({ origin: DEV_MODE?'*':(ALLOWED_ORIGIN||'').split(',').map(s=>s.trim()) }));
app.use(express.json());
app.use((req,res,next)=>{
  if(req.path==='/health')return next();
  if(!AUTH_ENABLED)return next();
  if(req.headers['x-client-key']!==CLIENT_KEY)return res.status(401).json({error:'Unauthorized'});
  next();
});
app.use('/chat', rateLimit({ windowMs:60_000, max:30, message:{error:'Límite alcanzado.'} }));

// ── UTILS ──
function norm(s=''){return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}\s]/gu,' ');}
function cleanTags(raw){if(!Array.isArray(raw))return[];return raw.map(t=>String(t).trim().toLowerCase()).filter(t=>t.length>0);}
function loadCore(){try{return JSON.parse(readFileSync(CORE_FILE,'utf-8'));}catch{return{nombre:'Ailari',proposito:'Asistente de decisiones',tono:'directa y clara',prioridades:[],reglas:[],trigger_deep:[],contexto_diego:{}};}}

function searchMemory(query){
  const all=typeof getAllMem==='function'?getAllMem():getAllMem.all();
  if(!all.length)return[];
  const words=norm(query).split(/\s+/).filter(w=>w.length>3);
  if(!words.length)return[];
  return all.map(m=>{
    const tags=Array.isArray(m.tags)?m.tags:JSON.parse(m.tags||'[]');
    const score=words.filter(w=>norm(m.texto+' '+tags.join(' ')).includes(w)).length;
    return{...m,tags,score};
  }).filter(m=>m.score>0).sort((a,b)=>b.score-a.score).slice(0,2);
}

async function fetchT(url,opts){
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),TIMEOUT);
  try{return await fetch(url,{...opts,signal:ctrl.signal});}
  finally{clearTimeout(t);}
}
async function retry(fn,n=2){
  try{return await fn();}
  catch(e){
    if(n===0||e.message.includes('401')||e.message.includes('quota')||e.message.includes('rate'))throw e;
    await new Promise(r=>setTimeout(r,600));
    return retry(fn,n-1);
  }
}

// ── LLAMADAS A CADA IA ──

async function callGroq(prompt, isChat=false, messages=[], system='') {
  const msgs = isChat
    ? [{role:'system',content:system}, ...messages]
    : [{role:'user',content:prompt}];
  const res = await fetchT('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
    body:JSON.stringify({model:'llama-3.3-70b-versatile',messages,max_tokens:500})
  });
  const text=await res.text();
  let d;try{d=JSON.parse(text);}catch{throw new Error('Groq: respuesta inválida');}
  if(!res.ok)throw new Error(d.error?.message||'Error Groq');
  return d.choices[0].message.content;
}

async function callGemini(prompt) {
  const res = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:500}})
  });
  const text=await res.text();
  let d;try{d=JSON.parse(text);}catch{throw new Error('Gemini: respuesta inválida');}
  if(!res.ok)throw new Error(d.error?.message||'Error Gemini');
  return d.candidates[0].content.parts[0].text;
}

async function callPerplexity(prompt) {
  const res = await fetchT('https://api.perplexity.ai/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${PERPLEXITY_KEY}`},
    body:JSON.stringify({model:'llama-3.1-sonar-small-128k-online',messages:[{role:'user',content:prompt}],max_tokens:500})
  });
  const text=await res.text();
  let d;try{d=JSON.parse(text);}catch{throw new Error('Perplexity: respuesta inválida');}
  if(!res.ok)throw new Error(d.error?.message||'Error Perplexity');
  return d.choices[0].message.content;
}

async function callClaude(messages, system) {
  const res = await fetchT('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:500,system,messages})
  });
  const text=await res.text();
  let d;try{d=JSON.parse(text);}catch{throw new Error('Claude: respuesta inválida');}
  if(!res.ok)throw new Error(d.error?.message||'Error Claude');
  return d.content[0].text;
}

async function callGPT(prompt) {
  const res = await fetchT('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${GPT_KEY}`},
    body:JSON.stringify({model:'gpt-4o',messages:[{role:'user',content:prompt}],max_tokens:400})
  });
  const text=await res.text();
  let d;try{d=JSON.parse(text);}catch{throw new Error('GPT: respuesta inválida');}
  if(!res.ok)throw new Error(d.error?.message||'Error GPT');
  return d.choices[0].message.content;
}

// Llama a la mejor IA disponible para un rol dado
// Orden de preferencia por rol:
// generador: groq → gemini → claude → gpt → perplexity
// critico:   claude → gemini → perplexity → groq → gpt
// sintetizador: gpt → claude → groq → gemini → perplexity
async function callIA(rol, prompt, claudeMessages=null, system='') {
  const orden = {
    generador:    ['groq','gemini','claude','gpt','perplexity'],
    critico:      ['claude','gemini','perplexity','groq','gpt'],
    sintetizador: ['gpt','claude','groq','gemini','perplexity'],
    rapido:       ['groq','gemini','claude','perplexity','gpt'],
  };
  const prioridad = orden[rol] || orden.rapido;
  for (const ia of prioridad) {
    if (!IAS[ia]?.available) continue;
    try {
      if (ia==='groq')       return { texto: await callGroq(prompt), ia };
      if (ia==='gemini')     return { texto: await callGemini(prompt), ia };
      if (ia==='perplexity') return { texto: await callPerplexity(prompt), ia };
      if (ia==='claude')     return { texto: claudeMessages ? await callClaude(claudeMessages,system) : await callClaude([{role:'user',content:prompt}],system), ia };
      if (ia==='gpt')        return { texto: await callGPT(prompt), ia };
    } catch(e) {
      console.warn(`⚠️  ${IAS[ia].nombre} falló (${e.message}), intentando siguiente...`);
    }
  }
  throw new Error('Ninguna IA disponible pudo responder.');
}

function buildSystem(core, memCtx) {
  const c=core.contexto_diego||{};
  const ctx=c.rol?`Diego: ${c.rol}. Estilo: ${c.estilo||''}. Objetivo: ${c.objetivo_actual||''}.`:'';
  const mem=memCtx.length?`\nMemoria:\n${memCtx.map(m=>`- ${m.texto.slice(0,120)}`).join('\n')}`:'';
  return `Eres ${core.nombre}. ${core.proposito}
Tono: ${core.tono}
Prioridades: ${(core.prioridades||[]).join(' · ')}
Reglas: ${(core.reglas||[]).join(' · ')}
${ctx}${mem}
Responde en español. Sin markdown. Corto si simple, profundo si estratégico.`;
}

// ── POST /chat ──
app.post('/chat', async (req,res) => {
  const {message,mode:rawMode} = req.body;
  const rawHistory = Array.isArray(req.body.history)?req.body.history:[];
  const safeHistory = rawHistory
    .filter(h=>h&&['user','assistant'].includes(h.role))
    .slice(-4)
    .map(h=>({role:h.role,content:String(h.content||'').slice(0,500)}));

  if(typeof message!=='string'||!message.trim())
    return res.status(400).json({error:'Mensaje vacío.'});
  if(message.length>2000)
    return res.status(400).json({error:'Máximo 2000 caracteres.'});

  const msg=message.trim();
  const core=loadCore();
  const forcedMode=['deep','fast'].includes(rawMode)?rawMode:null;
  const isDeepRequested=forcedMode==='deep'||(!forcedMode&&(core.trigger_deep||[]).some(t=>norm(msg).includes(norm(t))));
  const isDeep=HAS_DEEP&&isDeepRequested;
  const mode=isDeep?'deep':'fast';

  if(forcedMode==='deep'&&!HAS_DEEP)
    return res.status(400).json({error:`Modo profundo necesita al menos 2 IAs. Disponibles: ${availableIAs.length}`,has_deep:false});

  const memCtx=searchMemory(msg);
  const system=buildSystem(core,memCtx);
  const claudeHistory=[...safeHistory,{role:'user',content:msg}];

  let response, ia_usada='';
  try {
    if(mode==='fast') {
      const r = await retry(()=>callIA('rapido', `${system}\n\nPregunta: ${msg}\n\nRespuesta:`, claudeHistory, system));
      response=r.texto; ia_usada=r.ia;
    } else {
      // TRIO con las IAs disponibles
      const gen  = await retry(()=>callIA('generador',    `${system}\n\nPregunta: ${msg}\n\nRespuesta clara y accionable:`));
      const crit = await retry(()=>callIA('critico',      `Detecta errores, riesgos e inconsistencias en esta respuesta:\n${gen.texto}\nSé directo.`));
      const sint = await retry(()=>callIA('sintetizador', `Pregunta: ${msg}\nRespuesta: ${gen.texto}\nCrítica: ${crit.texto}\nVersión final ejecutable:`));
      response=sint.texto;
      ia_usada=`${gen.ia}→${crit.ia}→${sint.ia}`;
    }
  } catch(err) {
    return res.status(500).json({error:err.name==='AbortError'?'Timeout.':err.message});
  }

  const id=uuid(), now=new Date().toISOString();
  const row={id,mensaje:msg,respuesta:response,modo:mode,ia_usada,memoria_usada:JSON.stringify(memCtx.map(m=>m.id)),created_at:now};
  typeof insertChat==='function'?insertChat(row):insertChat.run(row);

  res.json({id,response,mode,mem_used:memCtx.length>0,ia_usada});
});

// ── POST /memory/save ──
app.post('/memory/save',(req,res)=>{
  const{texto,chat_id,tipo='aprendizaje',pregunta,decision,ia_origen}=req.body;
  if(!texto?.trim())return res.status(400).json({error:'Texto requerido.'});
  const tags=cleanTags(req.body.tags);
  const row={id:uuid(),texto:texto.trim(),tags:JSON.stringify(tags),tipo,
    pregunta:tipo==='decision'?(pregunta||null):null,
    decision:tipo==='decision'?(decision||null):null,
    ia_origen:ia_origen||'',chat_id:chat_id||null,created_at:new Date().toISOString()};
  typeof insertMem==='function'?insertMem(row):insertMem.run(row);
  res.json({...row,tags});
});

app.get('/memory/search',(req,res)=>{if(!req.query.q)return res.json([]);res.json(searchMemory(req.query.q));});
app.get('/memory',(_,res)=>{const rows=(typeof getMem==='function'?getMem(50):getMem.all(50)).map(m=>({...m,tags:Array.isArray(m.tags)?m.tags:JSON.parse(m.tags||'[]')}));res.json(rows);});
app.get('/chats',(_,res)=>{const rows=(typeof getChats==='function'?getChats(20):getChats.all(20)).map(c=>({...c,memoria_usada:Array.isArray(c.memoria_usada)?c.memoria_usada:JSON.parse(c.memoria_usada||'[]')}));res.json(rows);});

// ── GET /health ──
app.get('/health',(_,res)=>{
  const core=loadCore();
  const stats=getHealthStats();
  res.json({
    status:'ok', nombre:core.nombre, version:'3.0.0',
    ias_disponibles: availableIAs.map(k=>IAS[k].nombre),
    has_deep:HAS_DEEP, dev_mode:DEV_MODE, auth_enabled:AUTH_ENABLED,
    chats:stats.chats, memories:stats.memories, ts:new Date().toISOString()
  });
});

const PORT=process.env.PORT||3001;
app.listen(PORT,()=>console.log(`✅ Ailari v3.0 en puerto ${PORT} | IAs: ${availableIAs.map(k=>IAS[k].nombre).join(', ')}`));
