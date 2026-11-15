-- =====================================================================
--  TESTGEGEVENS voor bezetting en verlof (alleen om te oefenen)
--  Draai dit na 04_verlof.sql. Wissen vóór de echte start (1 januari 2027)
--  met 06_verlof_testdata_wissen.sql.
--
--  Iedereen krijgt 18 vakantiedagen voor 2026 en een testpincode:
--    Grace 1001, Selena 1002, Damaris 1003, Stephanie 1004,
--    Mariska 2001, Lucia 2002, Varsha 2003
-- =====================================================================

-- 18 dagen voor 2026, niets meegenomen uit 2025
insert into app.leave_years(employee_id, year, days, carry_in)
select id, 2026, 18, 0 from app.employees where active
on conflict (employee_id, year) do update set days = excluded.days, carry_in = excluded.carry_in;

-- testpincodes
update app.employees e set pin_hash = extensions.crypt(t.pin, extensions.gen_salt('bf'))
from (values ('Grace','1001'),('Selena','1002'),('Damaris','1003'),('Stephanie','1004'),
             ('Mariska','2001'),('Lucia','2002'),('Varsha','2003')) t(name, pin)
where e.name = t.name;

-- verlof (eerst eventueel eerder geladen testverlof weghalen)
delete from app.leave where note like 'TEST%';
insert into app.leave(employee_id, kind, date_from, date_to, days, note)
select e.id, t.kind, t.f::date, t.t::date, t.days, 'TEST ' || t.note
from (values
  ('Grace',     'vakantie', '2026-03-09', '2026-03-13',  5, 'voorjaar'),
  ('Grace',     'vakantie', '2026-12-21', '2026-12-24',  4, 'kerst (gepland)'),
  ('Selena',    'ziek',     '2026-02-02', '2026-02-04',  3, 'griep'),
  ('Selena',    'ziek',     '2026-06-15', '2026-06-18',  4, 'ziek'),
  ('Selena',    'vakantie', '2026-08-03', '2026-08-14', 10, 'zomer'),
  ('Damaris',   'bijzonder','2026-05-20', '2026-05-20',  1, 'begrafenis'),
  ('Damaris',   'vakantie', '2026-11-16', '2026-11-20',  5, 'gepland'),
  ('Stephanie', 'vakantie', '2026-11-13', '2026-11-17',  4, 'lang weekend'),
  ('Mariska',   'vakantie', '2026-07-06', '2026-07-17', 10, 'zomer'),
  ('Mariska',   'ziek',     '2026-10-05', '2026-10-05',  1, 'tandarts'),
  ('Lucia',     'vakantie', '2026-04-06', '2026-04-10',  5, 'Pasen'),
  ('Varsha',    'vakantie', '2026-01-05', '2026-01-16', 10, 'januari'),
  ('Varsha',    'vakantie', '2026-09-07', '2026-09-11',  5, 'september'),
  ('Varsha',    'ziek',     '2026-11-12', '2026-11-13',  2, 'ziek')
) t(name, kind, f, t, days, note)
join app.employees e on e.name = t.name;

-- bezetting van de afgelopen 3 weken (maandag t/m zaterdag, niet bij verlof)
delete from app.attendance where entered_by = 'TEST';
insert into app.attendance(day, employee_id, store_code, entered_by)
select d::date, e.id, e.store_code, 'TEST'
from generate_series(app.today() - 21, app.today() - 1, interval '1 day') d
cross join app.employees e
where e.active and extract(isodow from d) < 7
  and not exists (select 1 from app.leave l where l.employee_id = e.id and d::date between l.date_from and l.date_to)
  and (e.store_code = 'IND' or (extract(day from d)::int + e.id) % 4 <> 0)   -- bij Mahony niet altijd iedereen
on conflict (day, employee_id) do nothing;
