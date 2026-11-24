-- =========================================================
-- 005: 主控人管理能力补全
--   1) 主控人身份归位到用户当前设备（QIAO / 86bfe099…）
--   2) 新增「主控人改任一成员昵称」RPC
--   3) rename_self 兼容主控人尚未有成员记录的情况（自动补一条 owner 成员）
--   4) 清理本轮验收用的临时群
-- =========================================================

-- 1) 主控人归位（用户手机设备 86bfe099…，昵称 QIAO）
update public.app_config
   set owner_user_id = '86bfe099-4ddc-427c-9ffa-929ca1db1f00'
 where id = true;

-- 2) 主控人改任一成员昵称
create or replace function public.admin_rename_member(p_group uuid, p_user uuid, p_nick text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  nm   text;
  old  text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTH');
  end if;
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;

  nm := btrim(coalesce(p_nick, ''));
  if char_length(nm) < 1 or char_length(nm) > 20 then
    return jsonb_build_object('ok', false, 'error', 'BAD_NICKNAME');
  end if;

  select nickname into old from public.members where group_id = p_group and user_id = p_user;
  if old is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_MEMBER');
  end if;

  update public.members set nickname = nm where group_id = p_group and user_id = p_user;

  if old <> nm then
    insert into public.messages(group_id, sender_id, sender_name, kind, body)
    values (p_group, auth.uid(), '系统', 'system', '主控人把「' || old || '」的昵称改为「' || nm || '」');
  end if;

  return jsonb_build_object('ok', true, 'nickname', nm, 'old', old);
end $$;

-- 3) rename_self：主控人若在该群还没有成员记录，自动补一条再改名
create or replace function public.rename_self(p_group uuid, p_nick text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  nm  text;
  old text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTH');
  end if;
  nm := btrim(coalesce(p_nick, ''));
  if char_length(nm) < 1 or char_length(nm) > 20 then
    return jsonb_build_object('ok', false, 'error', 'BAD_NICKNAME');
  end if;

  select nickname into old from public.members where group_id = p_group and user_id = auth.uid();

  if old is null then
    if not public.is_owner() then
      return jsonb_build_object('ok', false, 'error', 'NOT_MEMBER');
    end if;
    if not exists (select 1 from public.groups where id = p_group) then
      return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    end if;
    insert into public.members(group_id, user_id, nickname, role)
    values (p_group, auth.uid(), nm, 'owner');
    return jsonb_build_object('ok', true, 'nickname', nm);
  end if;

  update public.members set nickname = nm where group_id = p_group and user_id = auth.uid();

  if old <> nm then
    insert into public.messages(group_id, sender_id, sender_name, kind, body)
    values (p_group, auth.uid(), '系统', 'system', old || ' 改名为 ' || nm);
  end if;

  return jsonb_build_object('ok', true, 'nickname', nm);
end $$;

grant execute on function public.admin_rename_member(uuid, uuid, text) to authenticated;
grant execute on function public.rename_self(uuid, text) to authenticated;

-- 4) 清理验收临时群（成员/消息级联删除）
delete from public.groups where invite_code = 'TEST02' and name = '管理验收群';

-- 校验
select
  (select owner_user_id::text from public.app_config limit 1) as owner_uid,
  (select string_agg(proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and proname in ('rename_group','admin_rename_member','kick_member','rename_self','delete_group')) as fns,
  (select count(*) from public.groups) as groups,
  (select count(*) from public.members) as members;
