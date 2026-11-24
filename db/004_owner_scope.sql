-- =========================================================
-- 004: 把圈子管理权限收敛到「主控人」身份，不再绑定创建时的设备 uid
-- 原因：主控人换设备重新认领后，历史群的 owner_id 仍是旧匿名 uid，
--       旧校验（owner_id = auth.uid()）会导致改群名/删群/重置邀请码全部失败。
-- =========================================================

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
  if not exists (select 1 from public.groups where id = p_group) then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;

  update public.groups set name = nm where id = p_group;
  insert into public.messages(group_id, sender_id, sender_name, kind, body)
  values (p_group, auth.uid(), '系统', 'system', '群名已改为「' || nm || '」');

  return jsonb_build_object('ok', true, 'name', nm);
end $$;

create or replace function public.delete_group(p_group uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;
  if not exists (select 1 from public.groups where id = p_group) then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;

  delete from public.groups where id = p_group;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.reset_invite_code(p_group uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  code  text;
  tries int := 0;
begin
  if not public.is_owner() then
    return jsonb_build_object('ok', false, 'error', 'NOT_OWNER');
  end if;
  if not exists (select 1 from public.groups where id = p_group) then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
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

grant execute on function public.rename_group(uuid, text) to authenticated;
grant execute on function public.delete_group(uuid) to authenticated;
grant execute on function public.reset_invite_code(uuid) to authenticated;

select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and proname in ('rename_group', 'delete_group', 'reset_invite_code')
 order by proname;
