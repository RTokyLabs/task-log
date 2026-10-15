-- RT Task Log — TEAM UPGRADE
-- Run this once in Supabase: SQL Editor → New query → paste → Run.
-- Run it AFTER schema.sql (which you already ran). Safe to re-run.
--
-- What it adds:
--   • profiles: one row per person (name, role = manager | member, active).
--   • Everyone who already has an account when you run this becomes a MANAGER
--     (today that's only you). Everyone added later starts as a MEMBER.
--   • Managers can see every task and can assign tasks to members.
--   • Members see only their own tasks. On tasks assigned to them, they can update
--     status/progress/notes but cannot rename, re-date or delete them.

-- ───────────────────────── profiles ─────────────────────────
create table if not exists public.profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  email                 text not null default '',
  display_name          text not null check (char_length(btrim(display_name)) between 1 and 60),
  role                  text not null default 'member' check (role in ('manager', 'member')),
  active                boolean not null default true,       -- untick to hide someone who left
  must_change_password  boolean not null default true,       -- forces a new password on first sign-in
  created_at            timestamptz not null default now()
);

-- New sign-in accounts automatically get a member profile.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), coalesce(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'New member'))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Existing accounts (just you, today) become managers.
insert into public.profiles (id, email, display_name, role, must_change_password)
select u.id, coalesce(u.email, ''), coalesce(nullif(split_part(coalesce(u.email, ''), '@', 1), ''), 'Manager'), 'manager', false
from auth.users u
on conflict (id) do nothing;

-- Used by the access rules below. SECURITY DEFINER so it can read profiles
-- without tripping over profiles' own rules.
create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'manager' and p.active);
$$;

alter table public.profiles enable row level security;
drop policy if exists "profiles: read" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;
-- You see yourself; managers see everyone; members can see managers' names ("Assigned by …").
create policy "profiles: read" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or role = 'manager' or (select public.is_manager()));
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- People may only change their own name and the first-sign-in flag — never role or active.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, must_change_password) on public.profiles to authenticated;

-- ───────────────────────── tasks ─────────────────────────
alter table public.tasks add column if not exists assigned_by uuid references auth.users (id) on delete set null;
create index if not exists tasks_assigned_by_idx on public.tasks (assigned_by);

drop policy if exists "tasks: read own"   on public.tasks;
drop policy if exists "tasks: insert own" on public.tasks;
drop policy if exists "tasks: update own" on public.tasks;
drop policy if exists "tasks: delete own" on public.tasks;
drop policy if exists "tasks: read"   on public.tasks;
drop policy if exists "tasks: insert" on public.tasks;
drop policy if exists "tasks: update" on public.tasks;
drop policy if exists "tasks: delete" on public.tasks;

-- Read: your own tasks; managers read all.
create policy "tasks: read" on public.tasks for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

-- Create: your own task, or (managers only) a task assigned to someone else.
create policy "tasks: insert" on public.tasks for insert to authenticated
  with check (
    (user_id = (select auth.uid()) and assigned_by is null)
    or ((select public.is_manager()) and assigned_by = (select auth.uid()))
  );

-- Update: the owner, or the manager who assigned it.
create policy "tasks: update" on public.tasks for update to authenticated
  using (user_id = (select auth.uid()) or assigned_by = (select auth.uid()))
  with check (user_id = (select auth.uid()) or assigned_by = (select auth.uid()));

-- Delete: your own self-created tasks, or tasks you assigned. Members can't delete assigned work.
create policy "tasks: delete" on public.tasks for delete to authenticated
  using ((user_id = (select auth.uid()) and assigned_by is null) or assigned_by = (select auth.uid()));

-- Field-level rules the policies can't express.
create or replace function public.tasks_guard()
returns trigger language plpgsql as $$
begin
  -- Changes made from the Supabase dashboard (no signed-in user) are not restricted.
  if (select auth.uid()) is null then return new; end if;
  if new.user_id is distinct from old.user_id or new.assigned_by is distinct from old.assigned_by then
    raise exception 'A task cannot be moved to another person.' using errcode = '42501';
  end if;
  if old.assigned_by is not null and (select auth.uid()) <> old.assigned_by
     and (new.title is distinct from old.title or new.due_date is distinct from old.due_date) then
    raise exception 'Only your manager can rename or re-date an assigned task.' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists tasks_guard on public.tasks;
create trigger tasks_guard before update on public.tasks
  for each row execute function public.tasks_guard();
