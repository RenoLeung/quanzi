-- =========================================================
-- 003: 主控人管理能力（改群名 / 改昵称 / 踢人 / 删群）
-- =========================================================

-- 改群名（仅主控人 + 该群群主）
create or replace function public.rename_group(p_group uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare nm text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTH');
  end if;
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;
  nm := btrim(coalesce(p_name, ''));
  if char_length(nm) < 1 or char_length(nm) > 30 then
    return jsonb_build_object('ok', false, 'error', 'BAD_NAME');
  end if;
  if not exists (select 1 from public.groups where id = p_group and owner_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'NOT_GROUP_OWNER');
  end if;

  update public.groups set name = nm where id = p_group;
  insert into public.messages(group_id, sender_id, sender_name, kind, body)
  values (p_group, auth.uid(), '系统', 'system', '群名已改为「' || nm || '」');

  return jsonb_build_object('ok', true, 'name', nm);
end $$;

-- 踢人出群（仅主控人，不能踢自己）
create or replace function public.kick_member(p_group uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members;
begin
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;
  if p_user = auth.uid() then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_KICK_SELF');
  end if;

  select * into m from public.members where group_id = p_group and user_id = p_user;
  if m.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;

  delete from public.members where id = m.id;
  insert into public.messages(group_id, sender_id, sender_name, kind, body)
  values (p_group, auth.uid(), '系统', 'system', m.nickname || ' 已被移出群聊');

  return jsonb_build_object('ok', true, 'nickname', m.nickname);
end $$;

-- 改自己的昵称（任何成员都可以，主控人同样适用）
create or replace function public.rename_self(p_group uuid, p_nick text) returns jsonb
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
    return jsonb_build_object('ok', false, 'error', 'NOT_MEMBER');
  end if;

  update public.members set nickname = nm where group_id = p_group and user_id = auth.uid();

  if old <> nm then
    insert into public.messages(group_id, sender_id, sender_name, kind, body)
    values (p_group, auth.uid(), '系统', 'system', old || ' 改名为 ' || nm);
  end if;

  return jsonb_build_object('ok', true, 'nickname', nm);
end $$;

-- 删除整个圈子（仅主控人；storage 对象由前端先走 Storage API 清理）
create or replace function public.delete_group(p_group uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;
  if not exists (select 1 from public.groups where id = p_group and owner_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'NOT_GROUP_OWNER');
  end if;

  delete from public.groups where id = p_group;
  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.rename_group(uuid, text) to authenticated;
grant execute on function public.kick_member(uuid, uuid) to authenticated;
grant execute on function public.rename_self(uuid, text) to authenticated;
grant execute on function public.delete_group(uuid) to authenticated;

select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and proname in ('rename_group', 'kick_member', 'rename_self', 'delete_group')
 order by proname;
