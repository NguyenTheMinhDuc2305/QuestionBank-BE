-- Internal POC: browser uses Supabase Auth only. All data access goes through ai-core.
create table public.learning_objectives (
 id uuid primary key default gen_random_uuid(), code text unique not null,
 grade integer not null check(grade between 1 and 12), unit integer not null,
 general_name text not null, specific_name text not null, category text not null,
 content text not null, source_file text, source_record integer,
 created_at timestamptz not null default now()
);
create table public.images (
 id uuid primary key, bucket text not null, object_key text not null,
 prompt text not null, negative_prompt text not null default '', effective_prompt text not null,
 model_name text not null, provider_job_id text, file_hash text not null,
 generation_params jsonb not null default '{}', created_at timestamptz not null default now(),
 unique(bucket,object_key)
);
create table public.audios (
 id uuid primary key, bucket text not null, object_key text not null,
 transcript text not null, description text not null default '',
 model_name text not null, voice text not null, file_hash text not null,
 generation_params jsonb not null default '{}', created_at timestamptz not null default now(),
 unique(bucket,object_key)
);
create table public.generation_jobs (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 request_key uuid not null, config jsonb not null,
 status text not null default 'queued' check(status in ('queued','running','completed','failed')),
 checkpoint jsonb, completed_count integer not null default 0, error text,
 worker_id uuid, lease_until timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(owner_id,request_key)
);
create index generation_jobs_queue_idx on public.generation_jobs(status,created_at);
create index generation_jobs_owner_idx on public.generation_jobs(owner_id);
create table public.questions (
 id uuid primary key, question_type text not null check(question_type in ('COMP_SEL','TYPING','MATCH','ORDER','LISTEN')),
 bloom_level integer not null check(bloom_level between 1 and 4),
 status text not null default 'draft' check(status in ('draft','approved','retired')),
 instruction_text text not null default '', hint text not null default '', explanation text not null default '',
 job_id uuid not null references public.generation_jobs(id), item_index integer not null,
 created_at timestamptz not null default now(), unique(job_id,item_index), unique(id,question_type)
);
create table public.question_los (
 question_id uuid not null references public.questions(id) on delete cascade,
 lo_id uuid not null references public.learning_objectives(id), is_primary boolean not null default true,
 primary key(question_id,lo_id)
);
create index question_los_lo_idx on public.question_los(lo_id);
create table public.completion_questions (
 question_id uuid primary key, question_type text not null default 'COMP_SEL' check(question_type='COMP_SEL'),
 stem_text text not null, image_id uuid references public.images(id), audio_id uuid references public.audios(id),
 foreign key(question_id,question_type) references public.questions(id,question_type) on delete cascade
);
create table public.completion_options (
 id uuid primary key default gen_random_uuid(), question_id uuid not null references public.completion_questions(question_id) on delete cascade,
 text_content text not null, image_id uuid references public.images(id), audio_id uuid references public.audios(id),
 is_correct boolean not null, position integer not null check(position>=0), unique(question_id,position)
);
create unique index completion_one_correct_idx on public.completion_options(question_id) where is_correct;
create table public.typing_questions (
 question_id uuid primary key, question_type text not null default 'TYPING' check(question_type='TYPING'),
 stem_text text not null, image_id uuid references public.images(id), audio_id uuid references public.audios(id),
 answer_text text not null, completed_sentence text not null, answer_audio_id uuid references public.audios(id),
 case_sensitive boolean not null default false,
 foreign key(question_id,question_type) references public.questions(id,question_type) on delete cascade
);
create table public.matching_questions (
 question_id uuid primary key, question_type text not null default 'MATCH' check(question_type='MATCH'),
 foreign key(question_id,question_type) references public.questions(id,question_type) on delete cascade
);
create table public.matching_pairs (
 id uuid primary key default gen_random_uuid(), question_id uuid not null references public.matching_questions(question_id) on delete cascade,
 left_item_id uuid not null default gen_random_uuid(), right_item_id uuid not null default gen_random_uuid(),
 left_text text not null, right_text text not null,
 left_image_id uuid references public.images(id), right_image_id uuid references public.images(id),
 left_audio_id uuid references public.audios(id), right_audio_id uuid references public.audios(id),
 position integer not null check(position>=0), unique(question_id,position)
);
create table public.ordering_questions (
 question_id uuid primary key, question_type text not null default 'ORDER' check(question_type='ORDER'),
 correct_sentence text not null, answer_audio_id uuid references public.audios(id),
 foreign key(question_id,question_type) references public.questions(id,question_type) on delete cascade
);
create table public.ordering_tokens (
 id uuid primary key default gen_random_uuid(), question_id uuid not null references public.ordering_questions(question_id) on delete cascade,
 text_content text not null, audio_id uuid references public.audios(id),
 correct_position integer not null check(correct_position>=0), unique(question_id,correct_position)
);
create table public.listening_questions (
 question_id uuid primary key, question_type text not null default 'LISTEN' check(question_type='LISTEN'),
 foreign key(question_id,question_type) references public.questions(id,question_type) on delete cascade
);
create table public.listening_items (
 id uuid primary key default gen_random_uuid(), question_id uuid not null references public.listening_questions(question_id) on delete cascade,
 label text not null, spoken_text text not null,
 image_id uuid not null references public.images(id), audio_id uuid not null references public.audios(id),
 correct_position integer not null check(correct_position>=0), unique(question_id,correct_position)
);
-- No browser grants/policies. A verified, allowlisted user calls ai-core, which uses service_role.
do $$ declare t text; begin
 foreach t in array array['learning_objectives','images','audios','generation_jobs','questions','question_los','completion_questions','completion_options','typing_questions','matching_questions','matching_pairs','ordering_questions','ordering_tokens','listening_questions','listening_items'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
-- Safe claim: stale jobs fail rather than automatically repeating potentially billed calls.
create function public.claim_generation_job(p_worker uuid,p_lease integer)
returns setof public.generation_jobs language plpgsql set search_path='' as $$
begin
 update public.generation_jobs set status='failed', error='Worker lease expired; inspect checkpoint before starting a new job.', updated_at=now()
 where status='running' and lease_until<now();
 return query update public.generation_jobs set status='running',worker_id=p_worker,
 lease_until=now()+make_interval(secs=>least(greatest(p_lease,60),900)),updated_at=now()
 where id=(select id from public.generation_jobs where status='queued' order by created_at for update skip locked limit 1)
 returning *;
end $$;
create function public.enqueue_generation_job(p_owner uuid,p_key uuid,p_config jsonb,p_limit integer)
returns public.generation_jobs language plpgsql set search_path='' as $$
declare result public.generation_jobs;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into result from public.generation_jobs where owner_id=p_owner and request_key=p_key;
 if found then
  if result.config<>p_config then raise exception 'Idempotency key reused with different config'; end if;
  return result;
 end if;
 if (select count(*) from public.generation_jobs where owner_id=p_owner and status in ('queued','running'))>=p_limit then
  raise exception 'Active job limit reached';
 end if;
 insert into public.generation_jobs(owner_id,request_key,config) values(p_owner,p_key,p_config) returning * into result;
 return result;
end $$;
revoke all on function public.claim_generation_job(uuid,integer) from public,anon,authenticated;
revoke all on function public.enqueue_generation_job(uuid,uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.claim_generation_job(uuid,integer) to service_role;
grant execute on function public.enqueue_generation_job(uuid,uuid,jsonb,integer) to service_role;
