-- Porovnanie s inými obchodmi podľa EAN
ALTER TABLE products ADD COLUMN ean TEXT;                                    -- EAN/GTIN zo stránky produktu
ALTER TABLE products ADD COLUMN best_offer_price REAL;                       -- najnižšia ponuka na Heureke
ALTER TABLE products ADD COLUMN best_offer_url TEXT;                         -- stránka produktu na Heureke
ALTER TABLE products ADD COLUMN notify_elsewhere INTEGER NOT NULL DEFAULT 1; -- upozorniť, keď je inde lacnejšie
