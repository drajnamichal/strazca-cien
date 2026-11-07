# Strážca cien

PWA na sledovanie cien produktov na SK a CZ e-shopoch. Kontrola každých 5 hodín, Web Push notifikácia pri každej zmene ceny. Produkt pridáš odkazom alebo názvom (vtedy appka nájde najnižšiu cenu na Heureka.sk / Heureka.cz a sleduje ju).

Všetko beží na bezplatných službách, bez platobnej karty.

## Ako to funguje

```
PWA (telefón) ──► Cloudflare Worker + D1 ◄── GitHub Actions (Playwright scraper)
                     │  cron každých 5 h ──► spustí workflow     │
                     │                                           └─► Web Push na telefón
                     └─ po pridaní produktu spustí kontrolu hneď
```

| Časť | Služba | Free limit | Spotreba appky |
|---|---|---|---|
| PWA, API, cron | Cloudflare Workers | 100 000 požiadaviek/deň | desiatky/deň |
| Databáza | Cloudflare D1 | 5 GB | pár MB |
| Scraper | GitHub Actions | neobmedzene (verejné repo), 2 000 min/mes. (privátne) | cca 150–450 min/mes. |
| Notifikácie | Web Push (VAPID) | bez limitu | – |
| Kurz EUR/CZK | ECB denné kurzy | zadarmo | 1×/5 h |

Cron je zámerne vo Workeri, nie v GitHub `schedule`: GitHub plánované behy mešká a vo verejných repozitároch ich po 60 dňoch nečinnosti vypne.

## Inštalácia (cca 15 minút)

Potrebuješ účet na GitHube, bezplatný účet na Cloudflare a Node.js 20+.

1. **Repozitár.** Nahraj tento priečinok do nového GitHub repozitára (môže byť privátny).

2. **Databáza.**
   ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler d1 create strazca-cien
   ```
   Vypísané `database_id` vlož do `wrangler.toml`. Potom vytvor tabuľky (migrácie v `worker/migrations/`):
   ```bash
   npm run db:migrate
   ```
   Rovnaký príkaz spusti aj po každej aktualizácii appky, ktorá pridá novú migráciu.

3. **Kľúče pre notifikácie (VAPID).**
   ```bash
   npx web-push@3.6.7 generate-vapid-keys
   ```
   Verejný kľúč vlož do `wrangler.toml` (`VAPID_PUBLIC_KEY`). Oba si odlož na krok 6.

4. **Tajomstvá Workera.**
   ```bash
   openssl rand -hex 32            # toto je tvoj prístupový kľúč do appky
   npx wrangler secret put API_TOKEN
   npx wrangler secret put GITHUB_TOKEN
   ```
   `GITHUB_TOKEN` vytvoríš v GitHube: Settings, Developer settings, Fine-grained tokens. Daj mu prístup len k tomuto repozitáru a právo **Actions: Read and write**. V `wrangler.toml` nastav `GITHUB_REPO` na `tvoj-ucet/nazov-repa`.

5. **Nasadenie.**
   ```bash
   npm run deploy
   ```
   Dostaneš adresu typu `https://strazca-cien.tvoj-subdomena.workers.dev`.

6. **Tajomstvá GitHub Actions.** V repozitári: Settings, Secrets and variables, Actions, New repository secret:
   - `API_URL` – adresa Workera z kroku 5
   - `API_TOKEN` – rovnaký kľúč ako v kroku 4
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` – z kroku 3
   - `VAPID_SUBJECT` – `mailto:tvoj@email.sk`

7. **Automatické nasadenie (odporúčané).** Odteraz sa appka nasadí sama po každom merge do `main`, keď prejdú testy (workflow *Nasadenie*). Nové migrácie sa spustia automaticky a na konci prebehne smoke test nasadenej appky. Treba na to:
   - V Cloudflare: My Profile, API Tokens, Create Token, šablóna *Edit Cloudflare Workers*, pridaj oprávnenie *D1: Edit*.
   - V GitHube pridaj secrety `CLOUDFLARE_API_TOKEN` a `CLOUDFLARE_ACCOUNT_ID` (ID účtu nájdeš v Cloudflare dashboarde vpravo).
   - Vyplnený `worker/wrangler.toml` (`database_id`, `GITHUB_REPO`, `VAPID_PUBLIC_KEY`) commitni do repozitára. Nie sú to tajomstvá, tajomstvá sú vo `wrangler secret`.

8. **Telefón.** Otvor adresu Workera, zadaj prístupový kľúč, pridaj appku na plochu a v nastaveniach zapni notifikácie.
   Na iPhone (iOS 16.4+) fungujú notifikácie len z appky pridanej na plochu cez Safari: Zdieľať, Pridať na plochu.

## Používanie

- **Odkaz na produkt:** appka číta cenu zo štruktúrovaných dát stránky (schema.org JSON-LD, microdata, meta tagy). Tie má väčšina e-shopov. Ak cenu nenájde, v detaile produktu zadaj vlastný CSS selektor ceny.
- **Názov produktu:** prepínač SK/CZ určuje, či sa hľadá na Heureka.sk (€) alebo Heureka.cz (Kč). Appka vezme výsledky, ktorých názov obsahuje všetky slová z dopytu, vyradí podozrivo lacné položky (príslušenstvo pod 30 % mediánu) a sleduje najlacnejší produkt. Čím presnejší názov (napr. „iPhone 15 128GB“), tým lepší výsledok.
- **Upozornenia** si nastavíš v detaile produktu:
  - *Cieľová cena:* notifikácia príde, až keď cena klesne na cieľ alebo pod neho.
  - *Prah zmeny v %:* počíta sa od ceny pri poslednej notifikácii, takže sa sčítajú aj postupné malé poklesy.
  - *Zdraženie:* dá sa vypnúť, potom chodia len poklesy.
  - Bez nastavení príde notifikácia pri každej zmene.
- **Znova skladom:** appka číta dostupnosť zo štruktúrovaných dát stránky. Vypredaný produkt má v zozname štítok a keď sa vráti na sklad, príde notifikácia aj s cenou.
- **Falošné zľavy:** ak obchod uvádza prečiarknutú cenu, appka ju porovná s najnižšou cenou za 30 dní pred aktuálnou cenou (rovnaké pravidlo ako smernica EÚ Omnibus). Výsledok je *skutočná*, *menšia, než sa tvári* alebo *falošná* zľava. Pri histórii kratšej ako 30 dní to appka priamo povie.
- **Lacnejšie v inom obchode:** pri produkte pridanom cez odkaz appka prečíta zo stránky EAN, nájde ten istý produkt na Heureke a porovná ceny. Keď je inde lacnejšie aspoň o 1 %, príde jedna notifikácia (ďalšia až pri novom rozdiele) a v zozname aj detaile vidno najnižšiu ponuku s odkazom. Obchod bez EAN v štruktúrovaných dátach sa neporovnáva, aby appka nehlásila iný produkt s podobným názvom.
- **Opakované zlyhanie:** keď kontrola produktu zlyhá 3× po sebe, príde notifikácia s dôvodom, takže sa nestane, že produkt týždne potichu nesleduješ.
- **Pridanie cez zdieľanie:**
  - *Android:* po nainštalovaní appky na plochu sa objaví v ponuke Zdieľať. Zdieľaj produkt z e-shopu alebo prehliadača a hneď sa pridá. Funguje aj zdieľaný text bez odkazu, vtedy sa hľadá podľa názvu.
  - *iPhone:* iOS zatiaľ nedovoľuje PWA byť v ponuke Zdieľať. Vytvor si v appke Skratky skratku: zapni *Zobraziť v hárku zdieľania* (typ vstupu URL a text), pridaj akciu *Otvoriť URL* s adresou `https://TVOJ-WORKER.workers.dev/?url=` a za ňu vlož *Vstup skratky*. Potom zdieľaš produkt cez túto skratku.
- **Prepočet mien:** v nastaveniach zapneš zobrazenie ceny aj v druhej mene podľa kurzu ECB.

## Kanárik: kontrola živých e-shopov

Testy bežia nad lokálnymi kópiami stránok, ale e-shopy svoje stránky menia. Preto workflow *Kanárik* (`.github/workflows/canary.yml`) raz denne skontroluje známe produkty na skutočných obchodoch rovnakým kódom, aký používa appka, a overí, že cena aj mena dávajú zmysel.

- Produkty sú v `scraper/canary.config.mjs`. Predvolene je tam hľadanie na Heureka.sk a Heureka.cz. **Doplň jeden dlhodobo predávaný produkt z každého obchodu, ktorý sleduješ.**
- Pri zlyhaní je beh červený (GitHub pošle e-mail), v behu je prehľadná tabuľka a na telefón príde notifikácia.
- Ručne: Actions, Kanárik, Run workflow. Lokálne: `cd scraper && npm run canary`.

## Testy

Pri každom pull requeste a po merge do `main` beží workflow **Testy** (`.github/workflows/tests.yml`) s troma paralelnými jobmi:

| Job | Čo overuje | Ako |
|---|---|---|
| Worker API | autorizácia, pridávanie, ukladanie výsledkov, notifikácie (cieľ, prah, zdraženie, znova skladom, inde lacnejšie, opakované zlyhanie, kanárik), 30-dňové minimum a verdikt zľavy, história, mazanie, cron | `node:test` cez verejné `fetch`/`scheduled` Workera, skutočné migrácie nad vstavaným `node:sqlite`; falošné je len GitHub API |
| Scraper | parsovanie cien (SK/CZ formáty, JSON-LD, AggregateOffer), dostupnosť, prečiarknutá cena, EAN a porovnanie na Heureke, výber najlacnejšieho výsledku, vyhodnotenie kanárika, celá kontrola v Chromiu | `node:test` + Playwright nad lokálnymi HTML fixtures (e-shop, JS e-shop, akcia, vypredaný produkt, Heureka vyhľadávanie a produkt, HTTP 403) |
| PWA E2E | zdieľanie do appky, upozornenia, falošné zľavy, vypredané produkty, inde lacnejšie, opakované zlyhanie, prvé spustenie, pridanie URL a názvu (SK/CZ), automatické doplnenie ceny, zoznam, prepočet mien, detail s grafom, CSS selektor, mazanie, deep link z notifikácie | `@playwright/test` na mobile (Pixel 7) aj desktope, API mockované falošným backendom v pamäti |

Pri chybe E2E sa ako artefakt uloží HTML report a trace.

Aby sa nedalo mergnúť s červenými testami, zapni v GitHube Settings, Branches, pravidlo pre `main` s **Require status checks to pass** a vyber joby Worker API, Scraper a PWA E2E.

Lokálne:

```bash
cd worker  && npm test                              # Node 22.13+
cd scraper && npm ci && npx playwright install chromium && npm test
cd e2e     && npm ci && npx playwright install chromium && npm test
```

Lokálna kontrola cien proti nasadenému Workeru: `cd scraper && API_URL=... API_TOKEN=... node check.mjs`.
Worker lokálne: `cd worker && npx wrangler dev` (lokálnu D1 vytvoríš cez `npx wrangler d1 migrations apply strazca-cien --local`).

## Obmedzenia

- Heureka a niektoré e-shopy majú ochranu proti robotom. Ak kontrola zlyhá, produkt ukáže chybu a skúsi sa to znova o 5 hodín. Scraper chodí po stránkach pomaly a s pauzami.
- Vyhľadávanie na Heureke používa heuristiku nezávislú od CSS tried, ale ak Heureka výrazne zmení stránku, treba upraviť `collectSearchResults` v `scraper/check.mjs`.
- Automatický scraping môže byť v rozpore s obchodnými podmienkami niektorých obchodov. Appka je určená na osobné použitie v malom rozsahu.
