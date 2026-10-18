-- Cortex database setup.
-- In Supabase: open your project → SQL Editor → New query → paste this whole file → Run.
-- Safe to run more than once.

-- 1) Per-person daily usage ------------------------------------------------
create table if not exists public.usage (
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null,
  messages int  not null default 0,
  checks   int  not null default 0,
  primary key (user_id, day)
);
alter table public.usage enable row level security;
drop policy if exists "read own usage" on public.usage;
create policy "read own usage" on public.usage for select using (auth.uid() = user_id);

-- Adds one use if the person is under their limit. Returns the new count, or null when the limit is reached.
create or replace function public.use_quota(p_user uuid, p_day date, p_kind text, p_limit int)
returns int language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into public.usage (user_id, day) values (p_user, p_day) on conflict do nothing;
  if p_kind = 'check' then
    update public.usage set checks = checks + 1
      where user_id = p_user and day = p_day and checks < p_limit returning checks into v;
  else
    update public.usage set messages = messages + 1
      where user_id = p_user and day = p_day and messages < p_limit returning messages into v;
  end if;
  return v;
end $$;

-- 2) Site-wide daily capacity per model (lets admins keep a reserve) --------
create table if not exists public.model_usage (
  day   date not null,
  model text not null,
  count int  not null default 0,
  primary key (day, model)
);
alter table public.model_usage enable row level security;  -- no policies: only the server can touch it

create or replace function public.reserve_model(p_day date, p_model text, p_cap int)
returns int language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into public.model_usage (day, model) values (p_day, p_model) on conflict do nothing;
  update public.model_usage set count = count + 1
    where day = p_day and model = p_model and count < p_cap returning count into v;
  return v;
end $$;

-- Only the server (service role) may call the counters.
revoke all on function public.use_quota(uuid, date, text, int) from public, anon, authenticated;
revoke all on function public.reserve_model(date, text, int) from public, anon, authenticated;
grant execute on function public.use_quota(uuid, date, text, int) to service_role;
grant execute on function public.reserve_model(date, text, int) to service_role;

-- 3) Saved chats, private to each account ----------------------------------
create table if not exists public.chats (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null default 'New chat',
  mode       text,
  messages   jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists chats_user_updated on public.chats (user_id, updated_at desc);
alter table public.chats enable row level security;
drop policy if exists "own chats select" on public.chats;
drop policy if exists "own chats insert" on public.chats;
drop policy if exists "own chats update" on public.chats;
drop policy if exists "own chats delete" on public.chats;
create policy "own chats select" on public.chats for select using (auth.uid() = user_id);
create policy "own chats insert" on public.chats for insert with check (auth.uid() = user_id);
create policy "own chats update" on public.chats for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own chats delete" on public.chats for delete using (auth.uid() = user_id);

-- 4) Give back a use when a request fails before producing an answer ----------
create or replace function public.refund_quota(p_user uuid, p_day date, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_kind = 'check' then
    update public.usage set checks = checks - 1 where user_id = p_user and day = p_day and checks > 0;
  else
    update public.usage set messages = messages - 1 where user_id = p_user and day = p_day and messages > 0;
  end if;
end $$;
revoke all on function public.refund_quota(uuid, date, text) from public, anon, authenticated;
grant execute on function public.refund_quota(uuid, date, text) to service_role;
