"""Convert the 'Digiorders filialen - Stocklist' CSV into supabase/03_products.sql.

Rules (agreed with the owner):
- Only stock numbers with a name and a valid current SRD price (column C) are imported.
- Column D (old prices), #REF! rows, empty codes are skipped.
- Built-in functions are not products: 1060 Saldo, 1646 Boodschappen, 2000 End of day,
  1645 Overgeslagen bon, 1030 Retour, 1022 Mitsu teller.
- Outdated items skipped: T-shirt blanks (1757-1783), batteries (1500-1527), 1643 sharpener, 1644 potloden.
- Supplies (photo paper, rolls, cartridges) are imported as non-sellable stock items (price 0).
- "Mahony ... only!" -> only Mahony; "indira only!" -> only Indira; "DNP print only!" -> counts for DNP counter.
- Stock tracking: on for frames, albums, USB, mugs, sublimation, paper/supplies, and
  'Diversen' items that had a stock column in the sheet. Starting stock is 0 (fresh count).
"""
import csv, re, sys

src, dst = sys.argv[1], sys.argv[2]
rows = list(csv.reader(open(src, encoding='utf-8-sig')))

SKIP = {'1060', '1646', '2000', '1645', '1030', '1022'} | {str(n) for n in range(1757, 1784)} \
       | {str(n) for n in range(1500, 1528)} | {'1643', '1644'}
SERVICE_IN_DIVERSEN = {'1602', '1606', '1608'}
SERVICES = {'1400'}  # inlijsten = dienst

def price(s):
    s = (s or '').strip()
    if not s or '#' in s:
        return None
    s = s.replace('.', '').replace(',', '.')
    try:
        return round(float(s), 2)
    except ValueError:
        return None

def sql(s):
    return 'null' if s is None else "'" + str(s).replace("'", "''") + "'"

section = 'Overig'
section_map = [
    ('PASFOTO', 'Pasfoto'), ('AFDRUKKEN', 'Afdrukken'), ('VERGROTINGEN', 'Vergrotingen'),
    ('NABESTELLINGEN', 'Nabestellingen'), ('REPRO', 'Repro'), ('BEWERKEN', 'Bewerken grafisch'),
    ('STUDIO', 'Studio'), ('LIJSTEN', 'Lijsten'), ('ALBUMS', 'Albums'), ('BATTERIJEN', 'Batterijen'),
    ('USB', 'USB / geheugenkaarten'), ('DIVERSEN', 'Diversen'), ('MOKKEN', 'Mokken'),
    ('OTHER SUBLIMATION', 'Sublimatie'), ('3G PRINT', 'T-shirt print'), ('VINYL PRINT', 'T-shirt print'),
    ('T-SHIRTS', 'T-shirts'), ('FOTO PAPIER', 'Fotopapier / rollen'), ('PAPIER', 'Papier'),
]
tracked_sections = {'Lijsten', 'Albums', 'USB / geheugenkaarten', 'Mokken', 'Sublimatie', 'Papier', 'Fotopapier / rollen'}
supply_sections = {'Papier', 'Fotopapier / rollen'}

out, skipped, seen = [], [], set()
order = 0
for r in rows:
    r = r + [''] * (30 - len(r))
    code, name = r[0].strip(), r[1].strip()
    if not code and name:
        up = name.upper()
        for key, cat in section_map:
            if key in up:
                section = cat
                break
        continue
    if not re.fullmatch(r'\d{4}', code) or code in seen:
        continue
    note = r[4].strip()
    p = price(r[2])
    if code in SKIP:
        skipped.append((code, name, 'ingebouwd/verouderd'))
        continue
    if not name or name.startswith('#'):
        continue
    supply = section in supply_sections and (p is None or p == 0) and code != '1811'
    if p is None and not supply:
        skipped.append((code, name, 'geen prijs'))
        continue
    seen.add(code)
    order += 1
    low = note.lower()
    only = None
    if 'mahony' in low and 'only' in low:
        only = 'MAH'
    elif 'indira' in low and 'only' in low:
        only = 'IND'
    dnp = 'dnp print only' in low
    if code in SERVICES:
        track = False
    elif section in tracked_sections:
        track = True
    elif section == 'Diversen':
        track = code not in SERVICE_IN_DIVERSEN and r[8].strip() != ''
    else:
        track = False
    keep_note = note if note and not re.search(r'only!|gelinkt|rows toevoegen|naamsveranderingen', note, re.I) else None
    out.append(f"({sql(code)},{sql(name)},{p or 0},{sql(section)},{sql(only)},{str(track).lower()},"
               f"{str(not supply).lower()},{str(dnp).lower()},{order},{sql(keep_note)})")

with open(dst, 'w', encoding='utf-8') as f:
    f.write('-- Super Photo POS - stap 3: artikelen uit de Stocklist (eenmalig draaien)\n')
    f.write('-- Gegenereerd door scripts/import_products.py. Bestaande artikelen worden niet overschreven.\n\n')
    f.write('insert into app.products (stock_no, name, price, category, only_store, track_stock, sellable, dnp_pasfoto, sort_order, note) values\n')
    f.write(',\n'.join(out))
    f.write('\non conflict (stock_no) do nothing;\n\n')
    f.write("insert into app.price_history (stock_no, price, valid_from)\n"
            "select stock_no, price, '-infinity' from app.products p\n"
            "where not exists (select 1 from app.price_history h where h.stock_no = p.stock_no);\n")
print(f'{len(out)} artikelen geschreven, {len(skipped)} overgeslagen')
for s in skipped:
    print('  overgeslagen:', *s)
