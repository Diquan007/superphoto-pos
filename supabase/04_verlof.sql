-- =====================================================================
--  Super Photo POS  -  database stap 4: bezetting en verlof
--  Plak dit na 01, 02 en 03 in Supabase > SQL Editor > Run.
--  Mag later opnieuw gedraaid worden bij een update (gegevens blijven).
--
--  Regels:
--   * Vakantie gaat af van de vakantiedagen.
--   * Ziek: de eerste 5 dagen per kalenderjaar worden doorbetaald;
--     daarna gaan ziektedagen af van de vakantiedagen.
--   * Bijzonder verlof wordt alleen vastgelegd en telt niet mee.
--   * Aan het eind van het jaar gaan maximaal 3 resterende dagen mee
--     naar het volgende jaar; de rest wordt uitbetaald.
--   * De kassa vult elke dag in wie er werkt. Alleen vandaag kan nog
--     gewijzigd worden; eerdere dagen kan alleen de beheerder aanpassen.
-- =====================================================================

-- ---------- sessies: ook voor medewerkers (alleen hun eigen verlof bekijken) ----------
alter table app.sessions drop constraint if exists sessions_role_check;
alter table app.sessions add constraint sessions_role_check check (role in ('terminal','admin','employee'));
alter table app.sessions add column if not exists employee_id bigint;

-- ---------- tabellen ----------
create table if not exists app.employees (
  id         bigserial primary key,
  name       text not null unique,
  store_code text not null references app.stores(code),
  pin_hash   text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- vaste werkdagen (1 = maandag ... 7 = zondag); parttimers werken minder dagen
alter table app.employees add column if not exists workdays int[] not null default '{1,2,3,4,5,6}';

-- vakantiedagen per jaar; een jaar zonder regel neemt het aantal van het vorige jaar over
create table if not exists app.leave_years (
  employee_id bigint not null references app.employees(id) on delete cascade,
  year        int not null check (year between 2000 and 2100),
  days        numeric(5,1) not null check (days >= 0),
  carry_in    numeric(5,1),            -- null = automatisch uit het vorige jaar (max 3)
  primary key (employee_id, year)
);

create table if not exists app.leave (
  id          bigserial primary key,
  employee_id bigint not null references app.employees(id) on delete cascade,
  kind        text not null check (kind in ('vakantie','ziek','bijzonder')),
  date_from   date not null,
  date_to     date not null,
  days        numeric(5,1) not null check (days > 0),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (date_to >= date_from),
  check (extract(year from date_from) = extract(year from date_to))
);
create index if not exists leave_emp_from on app.leave(employee_id, date_from);

-- wie werkt er op welke dag in welke winkel (één winkel per persoon per dag)
create table if not exists app.attendance (
  day         date not null,
  employee_id bigint not null references app.employees(id) on delete cascade,
  store_code  text not null references app.stores(code),
  entered_by  text,                    -- naam van de kassamedewerker of 'beheerder'
  entered_at  timestamptz not null default now(),
  primary key (day, employee_id)
);
create index if not exists attendance_day_store on app.attendance(day, store_code);

-- hele of halve dag, tijden en opmerking; een halve dag in elke winkel op één dag mag
alter table app.attendance add column if not exists fraction numeric(2,1) not null default 1;
alter table app.attendance add column if not exists time_from time;
alter table app.attendance add column if not exists time_to time;
alter table app.attendance add column if not exists note text;
alter table app.attendance drop constraint if exists attendance_fraction_check;
alter table app.attendance add constraint attendance_fraction_check check (fraction in (0.5, 1));
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'attendance_pkey'
             and pg_get_constraintdef(oid) not like '%store_code%') then
    alter table app.attendance drop constraint attendance_pkey;
    alter table app.attendance add primary key (day, employee_id, store_code);
  end if;
end $$;

insert into app.settings(key, value) values ('verlof_ziek_doorbetaald', '5'), ('verlof_max_meenemen', '3')
on conflict (key) do nothing;

-- medewerkers overnemen uit de lijsten van de kassa
insert into app.employees(name, store_code)
select distinct on (n) n, s.code from app.stores s, unnest(s.staff) n order by n, s.trans_prefix
on conflict (name) do nothing;

-- ===================== hulpfuncties =====================

create or replace function app.today() returns date
language sql stable as $$ select (now() at time zone 'America/Paramaribo')::date $$;

create or replace function app.setting_num(p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = app, public, extensions as $$
  select coalesce((select value::numeric from app.settings where key = p_key and value ~ '^[0-9]+(\.[0-9]+)?$'), p_default)
$$;

create or replace function app.check_employee(p_token uuid) returns bigint
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_id bigint;
begin
  select employee_id into v_id from app.sessions where token = p_token and role = 'employee' and expires_at > now();
  if v_id is null then perform app.err('SESSIE_VERLOPEN'); end if;
  return v_id;
end $$;

-- Houdt de medewerkerslijst van de kassa's gelijk aan de zichtbare medewerkers
create or replace function app.sync_store_staff() returns void
language sql security definer set search_path = app, public, extensions as $$
  update app.stores s set staff = coalesce((select array_agg(e.name order by e.name) from app.employees e
                                            where e.store_code = s.code and e.active), '{}')
  where s.code in ('MAH','IND')        -- Supabase weigert een UPDATE zonder WHERE
$$;

-- Saldo van één medewerker voor één jaar (berekent het meegenomen saldo uit het vorige jaar)
create or replace function app.leave_balance(p_emp bigint, p_year int) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare
  v_first int; v_days numeric := 0; v_carry numeric := 0; v_carry_set numeric; v_auto boolean := true;
  v_vak numeric; v_vak_planned numeric; v_ziek numeric; v_bijz numeric;
  v_paid numeric := app.setting_num('verlof_ziek_doorbetaald', 5);
  v_max  numeric := app.setting_num('verlof_max_meenemen', 3);
  v_extra numeric; v_rest numeric; v_prev jsonb;
begin
  select min(year) into v_first from app.leave_years where employee_id = p_emp;
  if v_first is not null and p_year >= v_first then
    select days into v_days from app.leave_years where employee_id = p_emp and year <= p_year order by year desc limit 1;
    select carry_in into v_carry_set from app.leave_years where employee_id = p_emp and year = p_year;
    if v_carry_set is not null then v_carry := v_carry_set; v_auto := false;
    elsif p_year > v_first then
      v_prev := app.leave_balance(p_emp, p_year - 1);
      v_carry := (v_prev->>'carry_out')::numeric;
    end if;
  end if;

  select coalesce(sum(days) filter (where kind = 'vakantie'), 0),
         coalesce(sum(days) filter (where kind = 'vakantie' and date_from > app.today()), 0),
         coalesce(sum(days) filter (where kind = 'ziek'), 0),
         coalesce(sum(days) filter (where kind = 'bijzonder'), 0)
    into v_vak, v_vak_planned, v_ziek, v_bijz
    from app.leave where employee_id = p_emp and extract(year from date_from) = p_year;

  v_extra := greatest(0, v_ziek - v_paid);
  v_rest  := coalesce(v_days, 0) + v_carry - v_vak - v_extra;
  return jsonb_build_object(
    'year', p_year, 'entitlement', coalesce(v_days, 0), 'set', v_first is not null and p_year >= v_first,
    'carry_in', v_carry, 'carry_auto', v_auto,
    'vakantie', v_vak, 'vakantie_gepland', v_vak_planned,
    'ziek', v_ziek, 'ziek_doorbetaald', least(v_ziek, v_paid), 'ziek_van_verlof', v_extra, 'ziek_max_doorbetaald', v_paid,
    'bijzonder', v_bijz,
    'remaining', v_rest,
    'carry_out', least(v_max, greatest(0, v_rest)), 'payout', greatest(0, v_rest - v_max), 'max_carry', v_max);
end $$;

create or replace function app.leave_rows(p_where_emp bigint, p_year int) returns jsonb
language sql stable security definer set search_path = app, public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'employee_id', l.employee_id, 'kind', l.kind,
            'date_from', l.date_from, 'date_to', l.date_to, 'days', l.days, 'note', l.note) order by l.date_from), '[]'::jsonb)
  from app.leave l
  where (p_where_emp is null or l.employee_id = p_where_emp) and extract(year from l.date_from) = p_year
$$;

-- Bezetting van één dag: wie werkt waar, wie heeft verlof, wie kan gekozen worden
create or replace function app.roster_json(p_day date) returns jsonb
language sql stable security definer set search_path = app, public, extensions as $$
  select jsonb_build_object(
    'day', p_day, 'today', app.today(),
    'stores', (select jsonb_agg(jsonb_build_object(
        'code', s.code,
        'workers', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'home', e.store_code,
                         'fraction', a.fraction, 'time_from', to_char(a.time_from, 'HH24:MI'), 'time_to', to_char(a.time_to, 'HH24:MI'), 'note', a.note) order by e.name)
                     from app.attendance a join app.employees e on e.id = a.employee_id
                     where a.day = p_day and a.store_code = s.code), '[]'::jsonb),
        'entered_by', (select a.entered_by from app.attendance a where a.day = p_day and a.store_code = s.code order by a.entered_at desc limit 1),
        'entered_at', (select max(a.entered_at) from app.attendance a where a.day = p_day and a.store_code = s.code))
        order by s.trans_prefix) from app.stores s),
    'on_leave', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'store_code', e.store_code, 'kind', l.kind,
                     'date_from', l.date_from, 'date_to', l.date_to) order by e.name)
                   from app.leave l join app.employees e on e.id = l.employee_id
                   where p_day between l.date_from and l.date_to), '[]'::jsonb),
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'store_code', e.store_code) order by e.name)
                   from app.employees e where e.active), '[]'::jsonb))
$$;

create or replace function app.roster_entries(p jsonb)
returns table (employee_id bigint, fraction numeric, time_from time, time_to time, note text)
language sql immutable as $$
  select (x->>'id')::bigint, coalesce(nullif(x->>'fraction', '')::numeric, 1),
         nullif(x->>'from', '')::time, nullif(x->>'to', '')::time, nullif(left(trim(x->>'note'), 200), '')
  from jsonb_array_elements(p) x
$$;

-- Bezetting van één winkel op één dag opslaan.
-- p_entries = [{"id":7, "fraction":1|0.5, "from":"08:00", "to":"16:00", "note":"..."}]
create or replace function app.set_roster(p_day date, p_store text, p_entries jsonb, p_by text) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_bad text; r record;
begin
  p_entries := coalesce(p_entries, '[]'::jsonb);
  begin
    perform array_agg(t) from app.roster_entries(p_entries) t;
  exception when others then perform app.err('Ongeldige tijd of invoer. Gebruik tijden als 08:00.');
  end;
  if (select count(*) <> count(distinct employee_id) from app.roster_entries(p_entries)) then
    perform app.err('Iemand staat twee keer in de lijst.');
  end if;
  if exists (select 1 from app.roster_entries(p_entries) where fraction not in (0.5, 1)) then perform app.err('Kies een hele of een halve dag.'); end if;
  select string_agg(e.name, ', ') into v_bad from app.roster_entries(p_entries) t join app.employees e on e.id = t.employee_id
    where t.time_from is not null and t.time_to is not null and t.time_to <= t.time_from;
  if v_bad is not null then perform app.err('De eindtijd moet na de begintijd liggen: ' || v_bad || '.'); end if;
  if exists (select 1 from app.roster_entries(p_entries) t where not exists (select 1 from app.employees e where e.id = t.employee_id and e.active)) then
    perform app.err('Onbekende medewerker in de lijst.');
  end if;
  -- wie vakantie heeft of ziek is, kan niet werken
  select string_agg(distinct e.name || ' (' || l.kind || ')', ', ') into v_bad
    from app.roster_entries(p_entries) t join app.employees e on e.id = t.employee_id
    join app.leave l on l.employee_id = t.employee_id and p_day between l.date_from and l.date_to and l.kind in ('vakantie', 'ziek');
  if v_bad is not null then
    perform app.err('Heeft vandaag verlof en kan niet ingevuld worden: ' || v_bad || '. Pas eerst het verlof aan bij Personeel & verlof.');
  end if;
  -- samen met de andere winkel niet meer dan één dag
  select string_agg(e.name || ' (' || case a.store_code when 'MAH' then 'Mahony' else 'Indira' end
                    || case when a.fraction = 1 then ', hele dag' else ', halve dag' end || ')', ', ') into v_bad
    from app.roster_entries(p_entries) t join app.attendance a on a.employee_id = t.employee_id and a.day = p_day and a.store_code <> p_store
    join app.employees e on e.id = t.employee_id
    where a.fraction + t.fraction > 1;
  if v_bad is not null then
    perform app.err('Al ingevuld bij de andere winkel: ' || v_bad || '. Samen mag het niet meer dan één dag zijn; kies een halve dag.');
  end if;
  delete from app.attendance a where a.day = p_day and a.store_code = p_store
    and not exists (select 1 from app.roster_entries(p_entries) t where t.employee_id = a.employee_id);
  insert into app.attendance(day, employee_id, store_code, entered_by, fraction, time_from, time_to, note)
  select p_day, t.employee_id, p_store, left(p_by, 50), t.fraction, t.time_from, t.time_to, t.note from app.roster_entries(p_entries) t
  on conflict (day, employee_id, store_code) do update
    set fraction = excluded.fraction, time_from = excluded.time_from, time_to = excluded.time_to, note = excluded.note,
        entered_by = excluded.entered_by, entered_at = now();
end $$;

-- oude vorm (lijst van id's = hele dagen), voor kassa's die nog niet bijgewerkt zijn
create or replace function app.ids_to_entries(p_ids bigint[]) returns jsonb
language sql immutable as $$ select coalesce(jsonb_agg(jsonb_build_object('id', i, 'fraction', 1)), '[]'::jsonb) from unnest(p_ids) i $$;

drop function if exists app.set_roster(date, text, bigint[], text);

-- ===================== kassa: bezetting =====================

create or replace function public.pos_roster(p_token uuid, p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare v_store text := app.check_session(p_token, 'terminal');
begin
  return app.roster_json(coalesce(p_day, app.today()));
end $$;

-- Alleen voor vandaag en alleen voor de eigen winkel
create or replace function public.pos_roster_set(p_token uuid, p_day date, p_ids bigint[], p_staff text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_store text := app.check_session(p_token, 'terminal');
begin
  if p_day is distinct from app.today() then
    perform app.err('Alleen de bezetting van vandaag kan worden ingevuld. Eerdere dagen kan alleen de beheerder wijzigen.');
  end if;
  perform app.set_roster(p_day, v_store, app.ids_to_entries(p_ids), coalesce(nullif(trim(p_staff), ''), 'kassa'));
  return app.roster_json(p_day);
end $$;

create or replace function public.pos_roster_save(p_token uuid, p_day date, p_entries jsonb, p_staff text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_store text := app.check_session(p_token, 'terminal');
begin
  if p_day is distinct from app.today() then
    perform app.err('Alleen de bezetting van vandaag kan worden ingevuld. Eerdere dagen kan alleen de beheerder wijzigen.');
  end if;
  perform app.set_roster(p_day, v_store, p_entries, coalesce(nullif(trim(p_staff), ''), 'kassa'));
  return app.roster_json(p_day);
end $$;

-- ===================== medewerker: eigen verlof bekijken =====================

create or replace function public.pos_staff_names() returns jsonb
language sql stable security definer set search_path = app, public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'store_code', store_code, 'has_pin', pin_hash is not null)
         order by store_code desc, name), '[]'::jsonb)
  from app.employees where active
$$;

create or replace function public.pos_employee_login(p_id bigint, p_pin text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare e app.employees; v_token uuid;
begin
  perform app.check_lockout('emp:' || coalesce(p_id, 0));
  select * into e from app.employees where id = p_id and active;
  if not found or e.pin_hash is null then
    perform app.err('Voor deze medewerker is nog geen pincode ingesteld. Vraag het de beheerder.');
  end if;
  if e.pin_hash <> crypt(coalesce(p_pin, ''), e.pin_hash) then
    insert into app.login_failures(key) values ('emp:' || p_id);
    perform app.err('Verkeerde pincode.');
  end if;
  delete from app.sessions where expires_at < now() - interval '1 day';
  insert into app.sessions(role, employee_id, expires_at) values ('employee', e.id, now() + interval '30 minutes')
  returning token into v_token;
  return jsonb_build_object('token', v_token, 'name', e.name);
end $$;

create or replace function public.pos_my_leave(p_token uuid, p_year int default null) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare v_emp bigint := app.check_employee(p_token); v_year int := coalesce(p_year, extract(year from app.today())::int); e app.employees;
begin
  select * into e from app.employees where id = v_emp;
  return jsonb_build_object(
    'name', e.name, 'store_code', e.store_code, 'year', v_year, 'today', app.today(),
    'balance', app.leave_balance(v_emp, v_year),
    'leave', app.leave_rows(v_emp, v_year),
    'worked', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'store_code', store_code, 'fraction', fraction,
                   'time_from', to_char(time_from, 'HH24:MI'), 'time_to', to_char(time_to, 'HH24:MI'), 'note', note) order by day desc, store_code desc)
                 from app.attendance where employee_id = v_emp and extract(year from day) = v_year), '[]'::jsonb));
end $$;

-- ===================== beheerder =====================

create or replace function public.pos_admin_roster(p_token uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return app.roster_json(coalesce(p_day, app.today()));
end $$;

create or replace function public.pos_admin_roster_set(p_token uuid, p_day date, p_store text, p_ids bigint[]) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  if p_store not in ('MAH','IND') then perform app.err('Onbekende winkel'); end if;
  if p_day > app.today() + 60 then perform app.err('Zo ver vooruit kan de bezetting niet worden ingevuld.'); end if;
  perform app.set_roster(p_day, p_store, app.ids_to_entries(p_ids), 'beheerder');
  return app.roster_json(p_day);
end $$;

create or replace function public.pos_admin_roster_save(p_token uuid, p_day date, p_store text, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  if p_store not in ('MAH','IND') then perform app.err('Onbekende winkel'); end if;
  if p_day > app.today() + 60 then perform app.err('Zo ver vooruit kan de bezetting niet worden ingevuld.'); end if;
  perform app.set_roster(p_day, p_store, p_entries, 'beheerder');
  return app.roster_json(p_day);
end $$;

create or replace function public.pos_admin_leave_overview(p_token uuid, p_year int) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return jsonb_build_object(
    'year', p_year, 'today', app.today(),
    'employees', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'name', e.name, 'store_code', e.store_code, 'active', e.active, 'has_pin', e.pin_hash is not null,
        'workdays', e.workdays, 'balance', app.leave_balance(e.id, p_year),
        'worked', (select coalesce(sum(a.fraction), 0) from app.attendance a where a.employee_id = e.id and extract(year from a.day) = p_year))
        order by e.store_code desc, e.name)
      from app.employees e), '[]'::jsonb),
    'leave', app.leave_rows(null, p_year));
end $$;

-- Maandoverzicht: verlof en bezetting per dag
create or replace function public.pos_admin_leave_month(p_token uuid, p_year int, p_month int) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare v_from date := make_date(p_year, p_month, 1); v_to date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
begin
  perform app.check_session(p_token, 'admin');
  return jsonb_build_object(
    'from', v_from, 'to', v_to, 'today', app.today(),
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'store_code', store_code, 'workdays', workdays) order by store_code desc, name)
                   from app.employees where active), '[]'::jsonb),
    'leave', coalesce((select jsonb_agg(jsonb_build_object('employee_id', employee_id, 'kind', kind, 'date_from', date_from, 'date_to', date_to))
               from app.leave where date_to >= v_from and date_from <= v_to), '[]'::jsonb),
    'attendance', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'employee_id', employee_id, 'store_code', store_code, 'fraction', fraction))
                    from app.attendance where day between v_from and v_to), '[]'::jsonb));
end $$;

create or replace function public.pos_admin_leave_save(p_token uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_emp bigint := (p->>'employee_id')::bigint;
        v_from date := (p->>'date_from')::date; v_to date := (p->>'date_to')::date; v_days numeric := (p->>'days')::numeric;
        v_kind text := p->>'kind'; v_clash record;
begin
  perform app.check_session(p_token, 'admin');
  if not exists (select 1 from app.employees where id = v_emp) then perform app.err('Kies een medewerker.'); end if;
  if v_kind not in ('vakantie','ziek','bijzonder') then perform app.err('Kies het soort verlof.'); end if;
  if v_from is null or v_to is null or v_to < v_from then perform app.err('Vul een geldige periode in (tot en met mag niet vóór de begindatum liggen).'); end if;
  if extract(year from v_from) <> extract(year from v_to) then
    perform app.err('Verlof over de jaarwisseling: voer het in als twee stukken (tot 31 december en vanaf 1 januari).');
  end if;
  if v_days is null or v_days <= 0 or v_days * 2 <> round(v_days * 2) then perform app.err('Vul het aantal dagen in (halve dagen mag, bijv. 0,5).'); end if;
  if v_days > (v_to - v_from + 1) then perform app.err('Meer dagen dan er in de periode zitten.'); end if;
  select * into v_clash from app.leave where employee_id = v_emp and id is distinct from v_id
    and date_from <= v_to and date_to >= v_from limit 1;
  if found then
    perform app.err(format('Overlapt met ander verlof (%s, %s t/m %s).', v_clash.kind, to_char(v_clash.date_from, 'DD-MM-YYYY'), to_char(v_clash.date_to, 'DD-MM-YYYY')));
  end if;
  if v_id is null then
    insert into app.leave(employee_id, kind, date_from, date_to, days, note)
    values (v_emp, v_kind, v_from, v_to, v_days, nullif(trim(p->>'note'), '')) returning id into v_id;
  else
    update app.leave set employee_id = v_emp, kind = v_kind, date_from = v_from, date_to = v_to, days = v_days,
                         note = nullif(trim(p->>'note'), ''), updated_at = now() where id = v_id;
    if not found then perform app.err('Dit verlof bestaat niet meer.'); end if;
  end if;
  return jsonb_build_object('id', v_id, 'balance', app.leave_balance(v_emp, extract(year from v_from)::int));
end $$;

create or replace function public.pos_admin_leave_delete(p_token uuid, p_id bigint) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  delete from app.leave where id = p_id;
end $$;

-- Vakantiedagen per jaar, meegenomen dagen (leeg = automatisch) en pincode
create or replace function public.pos_admin_employee_save(p_token uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_emp bigint := (p->>'id')::bigint; v_year int := (p->>'year')::int; v_days numeric := (p->>'days')::numeric;
        v_carry numeric := nullif(p->>'carry_in', '')::numeric; v_pin text := nullif(p->>'pin', '');
begin
  perform app.check_session(p_token, 'admin');
  if not exists (select 1 from app.employees where id = v_emp) then perform app.err('Onbekende medewerker.'); end if;
  if v_year is null or v_year not between 2000 and 2100 then perform app.err('Ongeldig jaar.'); end if;
  if v_days is null or v_days < 0 or v_days > 100 or v_days * 2 <> round(v_days * 2) then perform app.err('Vul het aantal vakantiedagen in (0 tot 100, halve dagen mag).'); end if;
  if v_carry is not null and (v_carry < 0 or v_carry > 100) then perform app.err('Meegenomen dagen: 0 tot 100, of leeg voor automatisch.'); end if;
  insert into app.leave_years(employee_id, year, days, carry_in) values (v_emp, v_year, v_days, v_carry)
  on conflict (employee_id, year) do update set days = excluded.days, carry_in = excluded.carry_in;
  if v_pin is not null then
    if not app.valid_pin(v_pin) then perform app.err('Een pincode moet uit 4 tot 8 cijfers bestaan.'); end if;
    update app.employees set pin_hash = crypt(v_pin, gen_salt('bf')) where id = v_emp;
    delete from app.sessions where role = 'employee' and employee_id = v_emp;
  end if;
  return app.leave_balance(v_emp, v_year);
end $$;

-- Medewerker toevoegen of wijzigen (naam, winkel, vaste werkdagen, zichtbaar)
create or replace function public.pos_admin_employee_upsert(p_token uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_name text := left(trim(coalesce(p->>'name', '')), 50);
        v_store text := p->>'store_code'; v_active boolean := coalesce((p->>'active')::boolean, true);
        v_days int[]; v_year int := (p->>'year')::int; v_ent numeric := nullif(p->>'days', '')::numeric;
begin
  perform app.check_session(p_token, 'admin');
  if v_name = '' then perform app.err('Vul een naam in.'); end if;
  if v_store not in ('MAH','IND') then perform app.err('Kies de winkel.'); end if;
  select coalesce(array_agg(distinct d order by d), '{}') into v_days
    from jsonb_array_elements_text(coalesce(p->'workdays', '[1,2,3,4,5,6]'::jsonb)) x(d0), lateral (select d0::int as d) y
    where d between 1 and 7;
  if cardinality(v_days) = 0 then perform app.err('Kies minstens één werkdag.'); end if;
  if exists (select 1 from app.employees where lower(name) = lower(v_name) and id is distinct from v_id) then
    perform app.err('Er is al een medewerker met de naam ' || v_name || '. Gebruik bijvoorbeeld ook een achternaam of letter.');
  end if;
  if v_id is null then
    insert into app.employees(name, store_code, workdays, active) values (v_name, v_store, v_days, v_active) returning id into v_id;
    if v_year is not null and v_ent is not null then
      if v_ent < 0 or v_ent > 100 or v_ent * 2 <> round(v_ent * 2) then perform app.err('Vul het aantal vakantiedagen in (0 tot 100, halve dagen mag).'); end if;
      insert into app.leave_years(employee_id, year, days, carry_in) values (v_id, v_year, v_ent, 0);
    end if;
  else
    update app.employees set name = v_name, store_code = v_store, workdays = v_days, active = v_active where id = v_id;
    if not found then perform app.err('Deze medewerker bestaat niet meer.'); end if;
    if not v_active then delete from app.sessions where role = 'employee' and employee_id = v_id; end if;
  end if;
  perform app.sync_store_staff();
  return jsonb_build_object('id', v_id);
end $$;

-- Medewerker definitief verwijderen, met al het verlof en de bezetting
create or replace function public.pos_admin_employee_delete(p_token uuid, p_id bigint) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  delete from app.sessions where role = 'employee' and employee_id = p_id;
  delete from app.employees where id = p_id;
  perform app.sync_store_staff();
end $$;

-- Medewerkerslijsten van de kassa: houdt ook de verlofadministratie bij
create or replace function public.pos_admin_set_staff(p_token uuid, p_store text, p_staff text[]) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_names text[];
begin
  perform app.check_session(p_token, 'admin');
  select coalesce(array_agg(distinct left(trim(n), 50)), '{}') into v_names from unnest(p_staff) n where trim(n) <> '';
  update app.stores set staff = v_names where code = p_store;
  if to_regclass('app.employees') is not null then
    insert into app.employees(name, store_code) select n, p_store from unnest(v_names) n
    on conflict (name) do update set store_code = excluded.store_code, active = true;
    update app.employees set active = false where store_code = p_store and not (name = any(v_names));
  end if;
end $$;

-- Volledige back-up (zonder pincodes en sessies) als één JSON-bestand, nu met verlof
create or replace function public.pos_admin_export(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare v jsonb;
begin
  perform app.check_session(p_token, 'admin');
  v := jsonb_build_object(
    'exported_at', now(), 'format', 'superphoto-pos-backup-1',
    'stores', (select jsonb_agg(to_jsonb(s) - 'pin_hash') from app.stores s),
    'settings', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.settings x where key <> 'admin_pin_hash'),
    'counters', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.counters x),
    'products', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.products x),
    'price_history', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.price_history x),
    'stock', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.stock x),
    'stock_moves', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.stock_moves x),
    'customers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.customers x),
    'sales', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.sales x),
    'sale_lines', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.sale_lines x),
    'day_closes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.day_closes x),
    'proposals', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.proposals x));
  if to_regclass('app.employees') is not null then
    v := v || jsonb_build_object(
      'employees', (select coalesce(jsonb_agg(to_jsonb(x) - 'pin_hash'), '[]') from app.employees x),
      'leave_years', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.leave_years x),
      'leave', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.leave x),
      'attendance', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.attendance x));
  end if;
  return v;
end $$;

-- ===================== rechten =====================
revoke all on all functions in schema app from public;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'pos\_%' loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
