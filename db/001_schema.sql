-- =========================================================
-- 圈子 (Quanzi) schema v1  —  自研代码 + Supabase
-- 运行环境: Supabase SQL Editor (postgres 角色, 绕过 RLS)
-- =========================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'member_role') then
    create type public.member_role as enum ('owner', 'member');
  end if;
  if not exists (select 1 from pg_type where typname = 'msg_kind') then
    create type public.msg_kind as enum ('text', 'voice', 'image', 'file', 'system');
  end if;
end $$;

-- ---------------- app_config (单行, 无 RLS 策略, 仅 RPC 可达) ----------------
create table if not exists public.app_config (
  id                  boolean primary key default true check (id),
  owner_user_id       uuid,
  owner_claimed_at    timestamptz,
  owner_pass_hash     text not null,
  storage_quota_bytes bigint not null default 1073741824,
  storage_warn_ratio  numeric not null default 0.85,
  created_at          timestamptz not null default now()
);
alter table public.app_config enable row level security;

-- ---------------- groups ----------------
create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 30),
  owner_id    uuid not null,
  invite_code text not null unique,
  created_at  timestamptz not null default now()
);

-- ---------------- members (≤10 人由触发器强约束) ----------------
create table if not exists public.members (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups(id) on delete cascade,
  user_id      uuid not null,
  nickname     text not null check (char_length(btrim(nickname)) between 1 and 20),
  role         public.member_role not null default 'member',
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (group_id, user_id)
);
create index if not exists members_user_idx on public.members(user_id);
create index if not exists members_group_idx on public.members(group_id);

-- ---------------- messages ----------------
create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups(id) on delete cascade,
  sender_id     uuid not null,
  sender_name   text not null,
  kind          public.msg_kind not null default 'text',
  body          text,
  recalled_at   timestamptz,
  client_msg_id text,
  created_at    timestamptz not null default now()
);
create index if not exists messages_group_created_idx on public.messages(group_id, created_at desc);
create index if not exists messages_body_trgm on public.messages using gin (body gin_trgm_ops);
create unique index if not exists messages_client_idem_idx
  on public.messages(group_id, sender_id, client_msg_id) where client_msg_id is not null;

-- ---------------- attachments ----------------
create table if not exists public.attachments (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  message_id  uuid references public.messages(id) on delete set null,
  uploader_id uuid not null,
  bucket      text not null default 'quanzi-media',
  path        text not null,
  file_name   text not null,
  mime        text,
  size_bytes  bigint not null default 0,
  kind        public.msg_kind not null,
  duration_ms integer,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists attachments_group_idx on public.attachments(group_id, created_at desc);
create index if not exists attachments_size_idx on public.attachments(size_bytes desc);
create index if not exists attachments_name_trgm on public.attachments using gin (file_name gin_trgm_ops);

-- ---------------- message_reads (已读回执) ----------------
create table if not exists public.message_reads (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null,
  group_id   uuid not null,
  read_at    timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists message_reads_group_idx on public.message_reads(group_id);

-- =========================================================
-- 辅助函数
-- =========================================================
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from public.app_config c where c.id and c.owner_user_id = auth.uid());
$$;

create or replace function public.is_member(p_group uuid) returns boolean
language sql stable security definer set search_path = public, auth as $$
  select p_group is not null and exists (
    select 1 from public.members m where m.group_id = p_group and m.user_id = auth.uid()
  );
$$;

create or replace function public.path_group(p_name text) returns uuid
language plpgsql stable as $$
declare g uuid;
begin
  begin
    g := ((storage.foldername(p_name))[1])::uuid;
  exception when others then
    return null;
  end;
  return g;
end $$;

create or replace function public.gen_invite_code() returns text
language plpgsql as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code  text := '';
  i     int;
begin
  for i in 1..6 loop
    code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
  end loop;
  return code;
end $$;

-- 10 人上限：插入成员前强校验
create or replace function public.enforce_group_capacity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.members where group_id = new.group_id) >= 10 then
    raise exception 'GROUP_FULL' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists members_capacity_trg on public.members;
create trigger members_capacity_trg before insert on public.members
for each row execute function public.enforce_group_capacity();

-- 撤回：仅本人、2 分钟内、且清空正文
create or replace function public.guard_recall() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.recalled_at is not null and old.recalled_at is null then
    if old.sender_id <> auth.uid() then
      raise exception 'RECALL_NOT_OWNER' using errcode = 'P0001';
    end if;
    if old.created_at < now() - interval '2 minutes' then
      raise exception 'RECALL_EXPIRED' using errcode = 'P0001';
    end if;
    new.body := null;
  end if;
  return new;
end $$;

drop trigger if exists messages_recall_trg on public.messages;
create trigger messages_recall_trg before update on public.messages
for each row execute function public.guard_recall();

-- =========================================================
-- RLS 策略
-- =========================================================
alter table public.groups        enable row level security;
alter table public.members       enable row level security;
alter table public.messages      enable row level security;
alter table public.attachments   enable row level security;
alter table public.message_reads enable row level security;

drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups for select to authenticated
  using (public.is_member(id) or owner_id = auth.uid());

drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups for insert to authenticated
  with check (public.is_owner() and owner_id = auth.uid());

drop policy if exists groups_update on public.groups;
create policy groups_update on public.groups for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists groups_delete on public.groups;
create policy groups_delete on public.groups for delete to authenticated
  using (owner_id = auth.uid());

drop policy if exists members_select on public.members;
create policy members_select on public.members for select to authenticated
  using (public.is_member(group_id) or public.is_owner());

drop policy if exists members_update_self on public.members;
create policy members_update_self on public.members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists members_delete on public.members;
create policy members_delete on public.members for delete to authenticated
  using (user_id = auth.uid() or public.is_owner());

-- 注意: 无 members_insert 策略 → 只能通过 join_group RPC 入群(邀请码校验)

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (public.is_member(group_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_member(group_id));

drop policy if exists messages_recall_update on public.messages;
create policy messages_recall_update on public.messages for update to authenticated
  using (sender_id = auth.uid() and public.is_member(group_id))
  with check (sender_id = auth.uid() and public.is_member(group_id));

drop policy if exists attachments_select on public.attachments;
create policy attachments_select on public.attachments for select to authenticated
  using (public.is_member(group_id));

drop policy if exists attachments_insert on public.attachments;
create policy attachments_insert on public.attachments for insert to authenticated
  with check (uploader_id = auth.uid() and public.is_member(group_id));

drop policy if exists attachments_update_owner on public.attachments;
create policy attachments_update_owner on public.attachments for update to authenticated
  using (public.is_owner()) with check (public.is_owner());

drop policy if exists reads_select on public.message_reads;
create policy reads_select on public.message_reads for select to authenticated
  using (public.is_member(group_id));

drop policy if exists reads_insert on public.message_reads;
create policy reads_insert on public.message_reads for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(group_id));

-- =========================================================
-- Storage 私有桶
-- =========================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('quanzi-media', 'quanzi-media', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists quanzi_media_select on storage.objects;
create policy quanzi_media_select on storage.objects for select to authenticated
  using (bucket_id = 'quanzi-media' and public.is_member(public.path_group(name)));

drop policy if exists quanzi_media_insert on storage.objects;
create policy quanzi_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'quanzi-media' and public.is_member(public.path_group(name)));

-- =========================================================
-- RPC: 主控人认领 / 建群 / 邀请码 / 入群 / 存储用量 / 文件清理
-- =========================================================
create or replace function public.claim_owner(p_pass text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare cfg public.app_config;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTH');
  end if;
  select * into cfg from public.app_config where id;
  if cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_INITIALIZED');
  end if;
  if cfg.owner_user_id is not null and cfg.owner_user_id <> auth.uid() then
    return jsonb_build_object('ok', false, 'error', 'OWNER_TAKEN');
  end if;
  if extensions.crypt(p_pass, cfg.owner_pass_hash) <> cfg.owner_pass_hash then
    return jsonb_build_object('ok', false, 'error', 'BAD_PASS');
  end if;
  update public.app_config
     set owner_user_id = auth.uid(),
         owner_claimed_at = coalesce(owner_claimed_at, now())
   where id;
  return jsonb_build_object('ok', true, 'owner_id', auth.uid());
end $$;

create or replace function public.owner_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'claimed', (select c.owner_user_id is not null from public.app_config c where c.id),
    'is_owner', public.is_owner()
  );
$$;

create or replace function public.create_group(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
  code text;
  tries int := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTH');
  end if;
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;
  if char_length(btrim(coalesce(p_name, ''))) < 1 then
    return jsonb_build_object('ok', false, 'error', 'BAD_NAME');
  end if;
  loop
    tries := tries + 1;
    code := public.gen_invite_code();
    begin
      insert into public.groups(name, owner_id, invite_code)
      values (btrim(p_name), auth.uid(), code)
      returning * into g;
      exit;
    exception when unique_violation then
      if tries > 8 then raise; end if;
    end;
  end loop;
  insert into public.members(group_id, user_id, nickname, role)
  values (g.id, auth.uid(), '主控人', 'owner');
  return jsonb_build_object('ok', true, 'group_id', g.id, 'name', g.name, 'invite_code', g.invite_code);
end $$;

create or replace function public.reset_invite_code(p_group uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare code text; tries int := 0;
begin
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;
  if not exists (select 1 from public.groups where id = p_group and owner_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'NOT_GROUP_OWNER');
  end if;
  loop
    tries := tries + 1;
    code := public.gen_invite_code();
    begin
      update public.groups set invite_code = code where id = p_group;
      exit;
    exception when unique_violation then
      if tries > 8 then raise; end if;
    end;
  end loop;
  return jsonb_build_object('ok', true, 'invite_code', code);
end $$;

create or replace function public.join_group(p_code text, p_nickname text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
  m public.members;
  cnt int;
  nm text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTH');
  end if;
  nm := btrim(coalesce(p_nickname, ''));
  if char_length(nm) < 1 or char_length(nm) > 20 then
    return jsonb_build_object('ok', false, 'error', 'BAD_NICKNAME');
  end if;
  select * into g from public.groups where invite_code = upper(btrim(coalesce(p_code, '')));
  if g.id is null then
    return jsonb_build_object('ok', false, 'error', 'BAD_CODE');
  end if;

  select * into m from public.members where group_id = g.id and user_id = auth.uid();
  if m.id is not null then
    update public.members set nickname = nm, last_seen_at = now() where id = m.id;
    return jsonb_build_object('ok', true, 'group_id', g.id, 'group_name', g.name,
                              'nickname', nm, 'rejoined', true, 'invite_code', g.invite_code);
  end if;

  select count(*) into cnt from public.members where group_id = g.id;
  if cnt >= 10 then
    return jsonb_build_object('ok', false, 'error', 'GROUP_FULL', 'count', cnt);
  end if;

  insert into public.members(group_id, user_id, nickname) values (g.id, auth.uid(), nm)
  returning * into m;

  insert into public.messages(group_id, sender_id, sender_name, kind, body)
  values (g.id, auth.uid(), '系统', 'system', nm || ' 加入了群聊');

  return jsonb_build_object('ok', true, 'group_id', g.id, 'group_name', g.name,
                            'nickname', nm, 'invite_code', g.invite_code);
end $$;

create or replace function public.storage_usage() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  used  bigint;
  quota bigint;
  ratio numeric;
  files jsonb;
begin
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;

  select coalesce(sum((o.metadata->>'size')::bigint), 0) into used
    from storage.objects o where o.bucket_id = 'quanzi-media';

  select c.storage_quota_bytes, c.storage_warn_ratio into quota, ratio
    from public.app_config c where c.id;

  select coalesce(jsonb_agg(j), '[]'::jsonb) into files from (
    select jsonb_build_object(
             'id', a.id,
             'name', a.file_name,
             'size', a.size_bytes,
             'kind', a.kind,
             'mime', a.mime,
             'path', a.path,
             'bucket', a.bucket,
             'created_at', a.created_at,
             'message_id', a.message_id,
             'group_id', a.group_id
           ) as j
      from public.attachments a
     where a.deleted_at is null
     order by a.size_bytes desc
     limit 300
  ) s;

  return jsonb_build_object('ok', true, 'used', used, 'quota', quota,
                            'ratio', ratio, 'files', files);
end $$;

create or replace function public.delete_attachment(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.attachments;
begin
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;
  select * into a from public.attachments where id = p_id;
  if a.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;
  delete from storage.objects where bucket_id = a.bucket and name = a.path;
  update public.attachments set deleted_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'freed', a.size_bytes);
end $$;

-- =========================================================
-- Realtime: 真 WebSocket 推送到 messages / reads / members / attachments
-- =========================================================
alter table public.messages      replica identity full;
alter table public.message_reads replica identity full;
alter table public.members       replica identity full;
alter table public.attachments   replica identity full;

do $$
declare t text;
begin
  foreach t in array array['messages', 'message_reads', 'members', 'attachments'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- =========================================================
-- 权限（RLS 负责行级，这里只放开表级给登录用户）
-- =========================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.groups, public.members, public.messages, public.attachments, public.message_reads
  to authenticated;
grant select on public.app_config to authenticated;

grant execute on function
  public.is_owner(), public.is_member(uuid), public.path_group(text),
  public.gen_invite_code(), public.claim_owner(text), public.owner_state(),
  public.create_group(text), public.reset_invite_code(uuid),
  public.join_group(text, text), public.storage_usage(), public.delete_attachment(uuid)
  to authenticated;

-- =========================================================
-- 初始化：存储配额 1GB / 告警阈值 85% / 主控人口令
-- =========================================================
insert into public.app_config (id, owner_pass_hash, storage_quota_bytes, storage_warn_ratio)
values (true, extensions.crypt('quanzi2026owner', extensions.gen_salt('bf')), 1073741824, 0.85)
on conflict (id) do nothing;

-- 完成校验
select
  (select count(*) from information_schema.tables where table_schema = 'public') as tables,
  (select count(*) from pg_policies where schemaname = 'public') as policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f') as functions,
  (select string_agg(tablename, ',' order by tablename)
     from pg_publication_tables where pubname = 'supabase_realtime') as realtime_tables;