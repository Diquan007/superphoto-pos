-- =====================================================================
--  Testgegevens van bezetting en verlof WISSEN (vóór de echte start)
--  Haalt ALLE ingevoerde bezetting en ALLE verlof weg, en de pincodes
--  en vakantiedagen van het personeel. De medewerkers zelf blijven staan.
--  Daarna in Beheer > Personeel & verlof de echte gegevens invullen.
-- =====================================================================
delete from app.attendance;
delete from app.leave;
delete from app.leave_years;
update app.employees set pin_hash = null;
delete from app.sessions where role = 'employee';
