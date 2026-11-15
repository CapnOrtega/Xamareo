# RB IPTV – Xbox Series S (developer mode)

Webapp (HTML/CSS/JS) in de stijl van jouw screenshots, voor providers met Xtream Codes (`player_api.php`).

## Wat zit erin
- Tabs: Live TV, Movies, Series, Favourites, Search, Menu
- Categorie-pills, sortering (A–Z / Newest / Most popular), Trending (via TMDB)
- Menu: categorieën tonen/verbergen, catalogus verversen, cache wissen, poster grid size (3–10), Intro overslaan (Aan/Uit + 15/30/60/90/120s), Favourites volgorde, Sign out
- **Zoeken op acteur** (tab Search → Acteur) en op acteursnaam klikken in het detailscherm
- Bediening met Xbox-controller (D-pad/stick = navigeren, A = kiezen, B = terug)

## Instellen
1. Inloggen met server-URL (bijv. `http://provider:8080`), gebruikersnaam en wachtwoord.
2. Voor acteur-zoeken en Trending: gratis TMDB API-sleutel (themoviedb.org → Instellingen → API). Invullen bij inloggen of in Menu → TMDB.

## Op de Xbox zetten
1. Xbox: installeer **Dev Home** (Microsoft Store), zet het toestel in **Developer Mode** (Xbox-Developer-account van $19 eenmalig nodig, activatie via Dev Mode Activation-app) en noteer het IP + pairing-PIN.
2. Pak de app in als Xbox-pakket met **PWABuilder** (pwabuilder.com):
   - Zet de map `rbiptv` op een HTTPS-host (bijv. GitHub Pages / Netlify) en geef de URL in PWABuilder.
   - Kies **Windows → Xbox** (of "Windows Package, Xbox") en download het pakket (.msixbundle).
3. Installeer via de **Xbox Device Portal** (`https://<xbox-ip>:11443`): Apps → Add → kies het pakket → Go.
4. Start de app onder *Dev Home → Mijn games en apps*.

## Belangrijk om te weten
- **hls.js**: Live TV (.m3u8) heeft hls.js nodig. Download `https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js` en leg het als `hls.min.js` naast `index.html` (kon ik hier niet downloaden).
- **CORS / http**: een webapp mag alleen provider-API's aanroepen als die CORS toestaan, en een https-pagina mag geen http-provider laden (mixed content). Lukt inloggen niet, gebruik dan een CORS-proxy (Menu → TMDB & verbinding) of verpak de app als lokaal UWP-pakket zodat er geen web-origin is.
- **Formaten**: de Xbox speelt mp4/h264 en HLS goed af; .mkv-bestanden van sommige providers kunnen weigeren.
- Ik kon hier geen echt Xbox-pakket bouwen of op een Xbox testen; de app is getest op syntaxis, niet op een echte provider.
