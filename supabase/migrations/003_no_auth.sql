-- POC without login: jobs are owned by a fixed placeholder id, not a Supabase Auth user.
alter table public.generation_jobs drop constraint if exists generation_jobs_owner_id_fkey;
alter table public.generation_jobs
  alter column owner_id set default '00000000-0000-0000-0000-000000000000';
