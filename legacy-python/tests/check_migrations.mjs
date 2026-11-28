// Run with PGLITE_MODULE pointing to a local @electric-sql/pglite module.
// Tests local WASM PostgreSQL only; never touches Supabase.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);`);
for (const name of ['001_initial.sql','002_persistence.sql','003_no_auth.sql']) {
  const sql = await readFile(new URL('../../supabase/migrations/'+name, import.meta.url), 'utf8');
  await db.exec(sql);
  console.log('Migration OK:', name);
}
const owner='00000000-0000-0000-0000-000000000000';
const key='22222222-2222-4222-8222-222222222222';
const worker='33333333-3333-4333-8333-333333333333';
await db.exec('set role service_role');
const lo=(await db.query(`insert into public.learning_objectives(code,grade,unit,general_name,specific_name,category,content) values('TEST',1,1,'School','Vocabulary','vocab','pen') returning id`)).rows[0].id;
const config={lo_id:lo,count:1,question_type:'COMP_SEL',bloom_level:1};
const enqueue=async k=>(await db.query('select * from public.enqueue_generation_job($1,$2,$3,1)',[owner,k,JSON.stringify(config)])).rows[0];
const job=await enqueue(key);
assert.equal((await enqueue(key)).id,job.id);
await assert.rejects(()=>enqueue('44444444-4444-4444-8444-444444444444'),/Active job limit/);
const claimed=(await db.query('select * from public.claim_generation_job($1,180)',[worker])).rows;
assert.equal(claimed[0].id,job.id);
assert.equal((await db.query('select * from public.claim_generation_job($1,180)',[worker])).rows.length,0);
const qid='55555555-5555-4555-8555-555555555555';
const q={id:qid,question_type:'COMP_SEL',bloom_level:1,instruction_text:'Choose',hint:'',explanation:'',item_index:0};
const records=[{table:'completion_questions',row:{question_id:qid,stem_text:'This is a ___.'}},
 ...['pen','cat','dog','bus'].map((text,i)=>({table:'completion_options',row:{question_id:qid,text_content:text,is_correct:i===0,position:i}}))];
const save=async payload=>db.query('select public.save_generated_question($1,$2,$3,$4,$5)',[job.id,worker,JSON.stringify(q),lo,JSON.stringify(payload)]);
// Missing correct option must roll back parent and details together.
await assert.rejects(()=>save(records.map(r=>r.table==='completion_options'?{...r,row:{...r.row,is_correct:false}}:r)),/Exactly one/);
assert.equal((await db.query('select count(*)::int as n from public.questions')).rows[0].n,0);
await save(records);
await save(records);
assert.equal((await db.query('select count(*)::int as n from public.questions')).rows[0].n,1);
assert.equal((await db.query('select count(*)::int as n from public.completion_options')).rows[0].n,4);
assert.equal((await db.query('select completed_count from public.generation_jobs')).rows[0].completed_count,1);
await assert.rejects(()=>db.query(`insert into public.typing_questions(question_id,stem_text,answer_text,completed_sentence) values($1,'___','x','x')`,[qid]),/foreign key/);
await db.exec('reset role; set role authenticated');
await assert.rejects(()=>db.query('select * from public.questions'),/permission denied/);
await assert.rejects(()=>db.query('select * from public.claim_generation_job($1,180)',[worker]),/permission denied/);
await db.close();
console.log('PASS: transaction rollback, save idempotency, job quota/claim, type FK and browser access denial.');
