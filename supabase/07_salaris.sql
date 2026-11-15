-- =====================================================================
--  Super Photo POS  -  database stap 7: personeelsgegevens en salaris
--  Plak dit na 04_verlof.sql in Supabase > SQL Editor > Run
--  (kies "Run without RLS"). Mag later opnieuw gedraaid worden.
--  Alleen toegankelijk met de beheerderspincode.
--
--  Regels:
--   * Vast salaris (per maand) of dagloon (parttime: dagloon x gewerkte dagen uit Bezetting).
--   * Betaling twee keer per maand (15e en 26e) of één keer (26e).
--     15e: periode 26e vorige maand t/m 14e;  26e (twee keer): 15e t/m 25e;
--     26e (één keer): 26e vorige maand t/m 25e.
--     Vast salaris bij twee keer per maand: op elke betaaldag de helft.
--   * Op de 26e: vervoerstoelage (per maand), voorschotten (in hun geheel) en aflossingen van leningen.
--   * Vakantiegeld op 26 augustus: dagloon x vakantiedagen van dat jaar / 2.
--   * Zaterdagen worden niet verrekend; er is alleen een overzicht (aantal x bedrag per persoon).
-- =====================================================================

create table if not exists app.employee_details (
  employee_id     bigint primary key references app.employees(id) on delete cascade,
  address         text,
  phone           text,
  birth_date      date,
  start_date      date,
  job_title       text,
  pay_type        text not null default 'vast' check (pay_type in ('vast','dagloon')),
  base_salary     numeric(12,2),          -- per maand (vast)
  day_wage        numeric(12,2),          -- dagloon (parttime; ook voor vakantiegeld)
  pay_schedule    text not null default 'twee' check (pay_schedule in ('twee','een')),
  transport       numeric(12,2),          -- vervoerstoelage per maand
  saturday_amount numeric(12,2),          -- extra per gewerkte zaterdag (alleen overzicht)
  payment_method  text not null default 'contant' check (payment_method in ('contant','bank')),
  bank_name       text,
  bank_account    text,
  bank_holder     text,
  notes           text,
  updated_at      timestamptz not null default now()
);

create table if not exists app.payslips (
  id             bigserial primary key,
  employee_id    bigint not null references app.employees(id) on delete cascade,
  pay_date       date not null,
  period_from    date not null,
  period_to      date not null,
  status         text not null default 'concept' check (status in ('concept','vast')),
  lines          jsonb not null default '[]',   -- [{code, label, amount, ref}]
  net            numeric(12,2) not null default 0,
  payment_method text not null,
  created_at     timestamptz not null default now(),
  finalized_at   timestamptz,
  unique (employee_id, pay_date)
);

create table if not exists app.advances (
  id          bigserial primary key,
  employee_id bigint not null references app.employees(id) on delete cascade,
  date        date not null,
  amount      numeric(12,2) not null check (amount > 0),
  note        text,
  payslip_id  bigint references app.payslips(id) on delete set null,   -- verrekend op deze loonstrook
  created_at  timestamptz not null default now()
);

create table if not exists app.loans (
  id          bigserial primary key,
  employee_id bigint not null references app.employees(id) on delete cascade,
  date        date not null,
  amount      numeric(12,2) not null check (amount > 0),
  installment numeric(12,2) not null check (installment > 0),          -- aflossing per maand
  note        text,
  created_at  timestamptz not null default now()
);

create table if not exists app.loan_payments (
  id          bigserial primary key,
  loan_id     bigint not null references app.loans(id) on delete cascade,
  date        date not null,
  amount      numeric(12,2) not null check (amount > 0),
  payslip_id  bigint references app.payslips(id) on delete cascade,     -- null = los afgelost
  note        text
);

-- ===================== hulpfuncties =====================

create or replace function app.loan_rest(p_loan bigint) returns numeric
language sql stable security definer set search_path = app, public, extensions as $$
  select l.amount - coalesce((select sum(amount) from app.loan_payments where loan_id = l.id), 0) from app.loans l where l.id = p_loan
$$;

-- periode van een betaaldag voor een schema
create or replace function app.pay_period(p_pay_date date, p_schedule text, out p_from date, out p_to date)
language plpgsql immutable as $$
declare first date := date_trunc('month', p_pay_date)::date;
begin
  if extract(day from p_pay_date) = 15 then
    p_from := (first - interval '1 month')::date + 25; p_to := first + 13;
  elsif p_schedule = 'twee' then
    p_from := first + 14; p_to := first + 24;
  else
    p_from := (first - interval '1 month')::date + 25; p_to := first + 24;
  end if;
end $$;

create or replace function app.r2(n numeric) returns numeric language sql immutable as $$ select round(coalesce(n, 0), 2) $$;
-- 1234.5 -> '1.234,50'
create or replace function app.srd(n numeric) returns text language sql immutable as $$
  select translate(to_char(coalesce(n, 0), 'FM999,999,990.00'), ',.', '.,') $$;

create or replace function app.details_json(p_emp bigint) returns jsonb
language sql stable security definer set search_path = app, public, extensions as $$
  select jsonb_build_object('id', e.id, 'name', e.name, 'store_code', e.store_code, 'active', e.active, 'workdays', e.workdays)
         || coalesce((select to_jsonb(d) - 'employee_id' from app.employee_details d where d.employee_id = e.id), '{}'::jsonb)
  from app.employees e where e.id = p_emp
$$;

-- concept-loonstrook berekenen (zonder op te slaan)
create or replace function app.payslip_lines(p_emp bigint, p_pay_date date) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare d app.employee_details; v_from date; v_to date; v_days numeric; v_lines jsonb := '[]'; v_ent numeric; r record; v_rest numeric;
begin
  select * into d from app.employee_details where employee_id = p_emp;
  if not found then d.pay_type := 'vast'; d.pay_schedule := 'twee'; end if;
  select p_from, p_to into v_from, v_to from app.pay_period(p_pay_date, d.pay_schedule);
  if d.pay_type = 'vast' then
    if coalesce(d.base_salary, 0) > 0 then
      v_lines := v_lines || jsonb_build_object('code', 'basis',
        'label', case when d.pay_schedule = 'twee' then 'Basissalaris (helft)' else 'Basissalaris' end,
        'amount', app.r2(case when d.pay_schedule = 'twee' then d.base_salary / 2 else d.base_salary end));
    end if;
  else
    select coalesce(sum(fraction), 0) into v_days from app.attendance where employee_id = p_emp and day between v_from and v_to;
    v_lines := v_lines || jsonb_build_object('code', 'dagloon',
      'label', format('%s gewerkte dag(en) x dagloon %s', replace(replace(trim(to_char(v_days, 'FM990.0')), '.0', ''), '.', ','), app.srd(d.day_wage)),
      'amount', app.r2(v_days * coalesce(d.day_wage, 0)));
  end if;
  if extract(day from p_pay_date) = 26 then
    if coalesce(d.transport, 0) > 0 then
      v_lines := v_lines || jsonb_build_object('code', 'vervoer', 'label', 'Vervoerstoelage', 'amount', app.r2(d.transport));
    end if;
    if extract(month from p_pay_date) = 8 and coalesce(d.day_wage, 0) > 0 then
      v_ent := (app.leave_balance(p_emp, extract(year from p_pay_date)::int)->>'entitlement')::numeric;
      if v_ent > 0 then
        v_lines := v_lines || jsonb_build_object('code', 'vakantiegeld',
          'label', format('Vakantiegeld (dagloon x %s vakantiedagen / 2)', replace(trim(to_char(v_ent, 'FM990.0')), '.0', '')),
          'amount', app.r2(d.day_wage * v_ent / 2));
      end if;
    end if;
    for r in select * from app.advances where employee_id = p_emp and payslip_id is null and date <= p_pay_date order by date loop
      v_lines := v_lines || jsonb_build_object('code', 'voorschot', 'ref', r.id,
        'label', 'Voorschot ' || to_char(r.date, 'DD-MM-YYYY') || coalesce(' (' || r.note || ')', ''), 'amount', -r.amount);
    end loop;
    for r in select * from app.loans where employee_id = p_emp and date <= p_pay_date order by date loop
      v_rest := app.loan_rest(r.id);
      if v_rest > 0 then
        v_lines := v_lines || jsonb_build_object('code', 'aflossing', 'ref', r.id,
          'label', 'Aflossing lening ' || to_char(r.date, 'DD-MM-YYYY') || ' (nog open ' || app.srd(v_rest) || ')',
          'amount', -least(r.installment, v_rest));
      end if;
    end loop;
  end if;
  return jsonb_build_object('from', v_from, 'to', v_to, 'lines', v_lines,
    'payment_method', coalesce(d.payment_method, 'contant'));
end $$;

create or replace function app.payslip_json(p_id bigint) returns jsonb
language sql stable security definer set search_path = app, public, extensions as $$
  select to_jsonb(p) || jsonb_build_object('name', e.name, 'store_code', e.store_code,
           'job_title', d.job_title, 'bank_name', d.bank_name, 'bank_account', d.bank_account, 'bank_holder', d.bank_holder)
  from app.payslips p join app.employees e on e.id = p.employee_id left join app.employee_details d on d.employee_id = p.employee_id
  where p.id = p_id
$$;

create or replace function app.lines_net(p_lines jsonb) returns numeric
language sql immutable as $$ select app.r2(sum((x->>'amount')::numeric)) from jsonb_array_elements(p_lines) x $$;

-- ===================== personeelsdossier =====================

create or replace function public.pos_admin_employee_details(p_token uuid, p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return app.details_json(p_id) || jsonb_build_object(
    'advances', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'date', a.date, 'amount', a.amount, 'note', a.note,
                   'payslip_id', a.payslip_id, 'pay_date', p.pay_date) order by a.date desc)
                 from app.advances a left join app.payslips p on p.id = a.payslip_id where a.employee_id = p_id), '[]'::jsonb),
    'loans', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'date', l.date, 'amount', l.amount, 'installment', l.installment,
                   'note', l.note, 'rest', app.loan_rest(l.id),
                   'payments', coalesce((select jsonb_agg(jsonb_build_object('date', lp.date, 'amount', lp.amount, 'payslip_id', lp.payslip_id, 'note', lp.note) order by lp.date)
                                         from app.loan_payments lp where lp.loan_id = l.id), '[]'::jsonb)) order by l.date desc)
              from app.loans l where l.employee_id = p_id), '[]'::jsonb),
    'payslips', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'pay_date', pay_date, 'status', status, 'net', net, 'payment_method', payment_method) order by pay_date desc)
                 from app.payslips where employee_id = p_id), '[]'::jsonb));
end $$;

create or replace function public.pos_admin_employee_details_save(p_token uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_id bigint := (p->>'id')::bigint;
begin
  perform app.check_session(p_token, 'admin');
  if not exists (select 1 from app.employees where id = v_id) then perform app.err('Onbekende medewerker.'); end if;
  if coalesce(p->>'pay_type', 'vast') not in ('vast','dagloon') then perform app.err('Kies vast salaris of dagloon.'); end if;
  if coalesce(p->>'pay_schedule', 'twee') not in ('twee','een') then perform app.err('Kies wanneer er betaald wordt.'); end if;
  if coalesce(p->>'payment_method', 'contant') not in ('contant','bank') then perform app.err('Kies contant of bank.'); end if;
  begin
    insert into app.employee_details as d (employee_id, address, phone, birth_date, start_date, job_title, pay_type, base_salary, day_wage,
      pay_schedule, transport, saturday_amount, payment_method, bank_name, bank_account, bank_holder, notes, updated_at)
    values (v_id, nullif(trim(p->>'address'), ''), nullif(trim(p->>'phone'), ''), nullif(p->>'birth_date', '')::date, nullif(p->>'start_date', '')::date,
      nullif(trim(p->>'job_title'), ''), coalesce(p->>'pay_type', 'vast'), nullif(p->>'base_salary', '')::numeric, nullif(p->>'day_wage', '')::numeric,
      coalesce(p->>'pay_schedule', 'twee'), nullif(p->>'transport', '')::numeric, nullif(p->>'saturday_amount', '')::numeric,
      coalesce(p->>'payment_method', 'contant'), nullif(trim(p->>'bank_name'), ''), nullif(trim(p->>'bank_account'), ''),
      nullif(trim(p->>'bank_holder'), ''), nullif(trim(p->>'notes'), ''), now())
    on conflict (employee_id) do update set address = excluded.address, phone = excluded.phone, birth_date = excluded.birth_date,
      start_date = excluded.start_date, job_title = excluded.job_title, pay_type = excluded.pay_type, base_salary = excluded.base_salary,
      day_wage = excluded.day_wage, pay_schedule = excluded.pay_schedule, transport = excluded.transport,
      saturday_amount = excluded.saturday_amount, payment_method = excluded.payment_method, bank_name = excluded.bank_name,
      bank_account = excluded.bank_account, bank_holder = excluded.bank_holder, notes = excluded.notes, updated_at = now();
  exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
    perform app.err('Controleer de datums en bedragen.');
  end;
  return app.details_json(v_id);
end $$;

-- voorschot / lening / losse aflossing
create or replace function public.pos_admin_money_save(p_token uuid, p jsonb) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_kind text := p->>'kind'; v_emp bigint := (p->>'employee_id')::bigint; v_amount numeric := (p->>'amount')::numeric;
        v_date date := coalesce(nullif(p->>'date', '')::date, app.today()); v_note text := nullif(trim(p->>'note'), '');
begin
  perform app.check_session(p_token, 'admin');
  if v_amount is null or v_amount <= 0 then perform app.err('Vul een bedrag in.'); end if;
  if v_kind = 'voorschot' then
    insert into app.advances(employee_id, date, amount, note) values (v_emp, v_date, app.r2(v_amount), v_note);
  elsif v_kind = 'lening' then
    if coalesce((p->>'installment')::numeric, 0) <= 0 then perform app.err('Vul de aflossing per maand in.'); end if;
    insert into app.loans(employee_id, date, amount, installment, note) values (v_emp, v_date, app.r2(v_amount), app.r2((p->>'installment')::numeric), v_note);
  elsif v_kind = 'aflossing' then
    if v_amount > app.loan_rest((p->>'loan_id')::bigint) then perform app.err('Meer dan er nog openstaat.'); end if;
    insert into app.loan_payments(loan_id, date, amount, note) values ((p->>'loan_id')::bigint, v_date, app.r2(v_amount), coalesce(v_note, 'los afgelost'));
  else perform app.err('Onbekend'); end if;
end $$;

create or replace function public.pos_admin_money_delete(p_token uuid, p_kind text, p_id bigint) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  if p_kind = 'voorschot' then
    if exists (select 1 from app.advances where id = p_id and payslip_id is not null) then perform app.err('Dit voorschot is al verrekend op een vastgezette loonstrook.'); end if;
    delete from app.advances where id = p_id;
  elsif p_kind = 'lening' then
    if exists (select 1 from app.loan_payments where loan_id = p_id and payslip_id is not null) then perform app.err('Op deze lening is al afgelost via een loonstrook.'); end if;
    delete from app.loans where id = p_id;
  else perform app.err('Onbekend'); end if;
end $$;

-- ===================== loonafrekening =====================

-- alle loonstroken van één betaaldag; maakt ontbrekende concepten aan
create or replace function public.pos_admin_payroll(p_token uuid, p_pay_date date, p_refresh boolean default false) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare e record; c jsonb;
begin
  perform app.check_session(p_token, 'admin');
  if extract(day from p_pay_date) not in (15, 26) then perform app.err('Betaaldag is de 15e of de 26e.'); end if;
  -- alleen wie salarisgegevens heeft (vast salaris of dagloon ingevuld)
  for e in select em.id from app.employees em join app.employee_details d on d.employee_id = em.id
           where em.active and (coalesce(d.base_salary, 0) > 0 or coalesce(d.day_wage, 0) > 0)
             and (extract(day from p_pay_date) = 26 or d.pay_schedule = 'twee') loop
    if p_refresh then delete from app.payslips where employee_id = e.id and pay_date = p_pay_date and status = 'concept'; end if;
    if not exists (select 1 from app.payslips where employee_id = e.id and pay_date = p_pay_date) then
      c := app.payslip_lines(e.id, p_pay_date);
      insert into app.payslips(employee_id, pay_date, period_from, period_to, lines, net, payment_method)
      values (e.id, p_pay_date, (c->>'from')::date, (c->>'to')::date, c->'lines', coalesce(app.lines_net(c->'lines'), 0), c->>'payment_method');
    end if;
  end loop;
  return jsonb_build_object('pay_date', p_pay_date,
    'payslips', coalesce((select jsonb_agg(app.payslip_json(ps.id) order by em.store_code desc, em.name)
                          from app.payslips ps join app.employees em on em.id = ps.employee_id where ps.pay_date = p_pay_date), '[]'::jsonb));
end $$;

create or replace function public.pos_admin_payslip(p_token uuid, p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return app.payslip_json(p_id);
end $$;

create or replace function public.pos_admin_payslip_save(p_token uuid, p_id bigint, p_lines jsonb, p_payment_method text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_lines jsonb;
begin
  perform app.check_session(p_token, 'admin');
  if exists (select 1 from app.payslips where id = p_id and status = 'vast') then perform app.err('Deze loonstrook is vastgezet. Heropen hem eerst.'); end if;
  if p_payment_method not in ('contant','bank') then perform app.err('Kies contant of bank.'); end if;
  begin
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('code', coalesce(x->>'code', 'extra'), 'label', left(coalesce(nullif(trim(x->>'label'), ''), 'Overig'), 120),
             'amount', app.r2((x->>'amount')::numeric), 'ref', x->'ref'))), '[]'::jsonb)
      into v_lines from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x;
  exception when others then perform app.err('Controleer de bedragen.');
  end;
  update app.payslips set lines = v_lines, net = coalesce(app.lines_net(v_lines), 0), payment_method = p_payment_method where id = p_id;
  return app.payslip_json(p_id);
end $$;

-- vastzetten: voorschotten en aflossingen worden afgeboekt
create or replace function public.pos_admin_payslip_finalize(p_token uuid, p_id bigint) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare p app.payslips; x jsonb;
begin
  perform app.check_session(p_token, 'admin');
  select * into p from app.payslips where id = p_id for update;
  if not found then perform app.err('Loonstrook niet gevonden.'); end if;
  if p.status = 'vast' then return app.payslip_json(p_id); end if;
  for x in select * from jsonb_array_elements(p.lines) loop
    if x->>'code' = 'voorschot' and x ? 'ref' then
      update app.advances set payslip_id = p_id where id = (x->>'ref')::bigint and payslip_id is null;
    elsif x->>'code' = 'aflossing' and x ? 'ref' and -(x->>'amount')::numeric > 0 then
      if -(x->>'amount')::numeric > app.loan_rest((x->>'ref')::bigint) + 0.001 then
        perform app.err('Een aflossing is hoger dan wat er nog openstaat op de lening.');
      end if;
      insert into app.loan_payments(loan_id, date, amount, payslip_id) values ((x->>'ref')::bigint, p.pay_date, -(x->>'amount')::numeric, p_id);
    end if;
  end loop;
  update app.payslips set status = 'vast', finalized_at = now() where id = p_id;
  return app.payslip_json(p_id);
end $$;

create or replace function public.pos_admin_payslip_reopen(p_token uuid, p_id bigint) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  update app.advances set payslip_id = null where payslip_id = p_id;
  delete from app.loan_payments where payslip_id = p_id;
  update app.payslips set status = 'concept', finalized_at = null where id = p_id;
  return app.payslip_json(p_id);
end $$;

create or replace function public.pos_admin_payslip_delete(p_token uuid, p_id bigint) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  if exists (select 1 from app.payslips where id = p_id and status = 'vast') then perform app.err('Heropen de loonstrook eerst.'); end if;
  delete from app.payslips where id = p_id;
end $$;

-- ===================== overzichten =====================

-- zaterdagen per persoon in een periode (alleen overzicht, niet verrekend)
create or replace function public.pos_admin_saturdays(p_token uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return coalesce((select jsonb_agg(x order by x->>'store_code' desc, x->>'name') from (
    select jsonb_build_object('id', e.id, 'name', e.name, 'store_code', e.store_code, 'saturday_amount', d.saturday_amount,
             'days', coalesce(sum(a.fraction), 0),
             'dates', coalesce(jsonb_agg(jsonb_build_object('day', a.day, 'store_code', a.store_code, 'fraction', a.fraction) order by a.day) filter (where a.day is not null), '[]'::jsonb),
             'total', app.r2(coalesce(sum(a.fraction), 0) * coalesce(d.saturday_amount, 0))) x
    from app.employees e
    left join app.employee_details d on d.employee_id = e.id
    left join app.attendance a on a.employee_id = e.id and a.day between p_from and p_to and extract(isodow from a.day) = 6
    where e.active or a.day is not null
    group by e.id, e.name, e.store_code, d.saturday_amount) q), '[]'::jsonb);
end $$;

-- vakantiegeld per persoon voor een jaar
create or replace function public.pos_admin_holiday_pay(p_token uuid, p_year int) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'store_code', e.store_code, 'day_wage', d.day_wage,
            'days', (app.leave_balance(e.id, p_year)->>'entitlement')::numeric,
            'amount', app.r2(coalesce(d.day_wage, 0) * (app.leave_balance(e.id, p_year)->>'entitlement')::numeric / 2))
          order by e.store_code desc, e.name)
    from app.employees e left join app.employee_details d on d.employee_id = e.id where e.active), '[]'::jsonb);
end $$;

-- back-up: ook deze gegevens (bevat bankgegevens: bestand goed bewaren)
create or replace function public.pos_admin_export_salaris(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return jsonb_build_object(
    'employee_details', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.employee_details x),
    'payslips', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.payslips x),
    'advances', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.advances x),
    'loans', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.loans x),
    'loan_payments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.loan_payments x));
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
