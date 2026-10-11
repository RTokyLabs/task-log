-- RT Task Log — database setup
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: it only creates what is missing.

create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title         text not null check (char_length(btrim(title)) between 1 and 200),
  notes         text not null default '' check (char_length(notes) <= 4000),
  log_date      date not null,                       -- the day the task is logged for (local date)
  due_date      date,
  priority      text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  category      text not null default '' check (char_length(category) <= 40),
  status        text not null default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'done')),
  progress      smallint not null default 0 check (progress between 0 and 100),
  prev_progress smallint not null default 0 check (prev_progress between 0 and 100),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Business rule: a task is Done exactly when its progress is 100%.
  constraint tasks_done_means_100 check ((status = 'done') = (progress = 100))
);

create index if not exists tasks_user_log_date_idx on public.tasks (user_id, log_date);
create index if not exists tasks_user_status_idx   on public.tasks (user_id, status);

-- Keep updated_at honest no matter which client writes.
create or replace function public.tasks_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.tasks_touch_updated_at();

-- Row Level Security: every signed-in user sees and changes only their own tasks.
-- Signed-out visitors (anyone holding just the public key) see nothing.
alter table public.tasks enable row level security;

drop policy if exists "tasks: read own"   on public.tasks;
drop policy if exists "tasks: insert own" on public.tasks;
drop policy if exists "tasks: update own" on public.tasks;
drop policy if exists "tasks: delete own" on public.tasks;

create policy "tasks: read own"   on public.tasks for select to authenticated using (user_id = (select auth.uid()));
create policy "tasks: insert own" on public.tasks for insert to authenticated with check (user_id = (select auth.uid()));
create policy "tasks: update own" on public.tasks for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "tasks: delete own" on public.tasks for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.tasks from anon;
grant select, insert, update, delete on public.tasks to authenticated;
