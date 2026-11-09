-- Zľavový kód rozpoznaný na stránke produktu (informácia popri hlavnej cene)
ALTER TABLE products ADD COLUMN promo_json TEXT;                          -- { code, percent, price, min_order, valid_until }
ALTER TABLE products ADD COLUMN notify_promo INTEGER NOT NULL DEFAULT 1;   -- upozorniť na nový zľavový kód
