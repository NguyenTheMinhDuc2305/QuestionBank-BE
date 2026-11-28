-- Only backend service_role may invoke these helpers.
create function public.save_generated_question(p_job uuid,p_worker uuid,p_question jsonb,p_lo uuid,p_records jsonb)
returns uuid language plpgsql set search_path='' as $$
declare qid uuid; rec jsonb; tab text; cols text; j public.generation_jobs;
begin
 select * into j from public.generation_jobs where id=p_job for update;
 if j.status<>'running' or j.worker_id<>p_worker or j.lease_until<now() then raise exception 'Invalid worker lease'; end if;
 qid=(p_question->>'id')::uuid;
 if exists(select 1 from public.questions where id=qid) then return qid; end if;
 insert into public.questions(id,question_type,bloom_level,instruction_text,hint,explanation,job_id,item_index)
 values(qid,p_question->>'question_type',(p_question->>'bloom_level')::int,p_question->>'instruction_text',p_question->>'hint',p_question->>'explanation',p_job,(p_question->>'item_index')::int);
 insert into public.question_los(question_id,lo_id) values(qid,p_lo);
 for rec in select value from jsonb_array_elements(p_records) loop
  tab=rec->>'table';
  if tab not in ('completion_questions','completion_options','typing_questions','matching_questions','matching_pairs','ordering_questions','ordering_tokens','listening_questions','listening_items') then raise exception 'Invalid detail table'; end if;
  if rec->'row'->>'question_id'<>qid::text then raise exception 'Invalid question reference'; end if;
  select string_agg(format('%I',key),',') into cols from jsonb_object_keys(rec->'row') as key;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1)',tab,cols,cols,tab) using rec->'row';
 end loop;
 if p_question->>'question_type'='COMP_SEL' and (select count(*) from public.completion_options where question_id=qid and is_correct)<>1 then raise exception 'Exactly one correct option required'; end if;
 update public.generation_jobs set completed_count=completed_count+1,updated_at=now() where id=p_job;
 return qid;
end $$;
revoke all on function public.save_generated_question(uuid,uuid,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_generated_question(uuid,uuid,jsonb,uuid,jsonb) to service_role;
-- Index all media FK columns to keep referential checks efficient.
do $$ declare r record; begin
 for r in select c.table_name,c.column_name from information_schema.columns c where c.table_schema='public' and c.column_name like '%audio_id' or (c.table_schema='public' and c.column_name like '%image_id') loop
  execute format('create index %I on public.%I(%I)',r.table_name||'_'||r.column_name||'_idx',r.table_name,r.column_name);
 end loop;
end $$;
create index questions_job_idx on public.questions(job_id);
