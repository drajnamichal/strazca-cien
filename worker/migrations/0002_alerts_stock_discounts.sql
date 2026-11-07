-- Cieľová cena, prah notifikácie, dostupnosť a pôvodná (prečiarknutá) cena
ALTER TABLE products ADD COLUMN target_price REAL;                         -- upozorni až pod touto cenou
ALTER TABLE products ADD COLUMN min_change_pct REAL;                       -- upozorni až pri zmene aspoň o X %
ALTER TABLE products ADD COLUMN notify_increase INTEGER NOT NULL DEFAULT 1; -- upozorniť aj na zdraženie
ALTER TABLE products ADD COLUMN notify_stock INTEGER NOT NULL DEFAULT 1;    -- upozorniť, keď je znova skladom
ALTER TABLE products ADD COLUMN last_notified_price REAL;                  -- cena pri poslednej notifikácii (základ pre prah)
ALTER TABLE products ADD COLUMN in_stock INTEGER;                          -- 1 skladom, 0 vypredané, NULL nevieme
ALTER TABLE products ADD COLUMN list_price REAL;                           -- cena „pred zľavou“, ktorú uvádza obchod
