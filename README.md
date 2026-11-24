# Souschefen

Adress: https://souschefen.pages.dev/ · Inköpslistan: https://souschefen.pages.dev/lista/

Familjens souschef, kokbok och inköpslista som webbapp för dator, mobil och platta. Använder Google Gemini (gratisnyckel).

## Det viktigaste

- **Förslag:** beskriv vad ni har (eller fota kylen) och få förslag med förklaring och hälsogradering (bra / neutral / mindre bra mot hälsomålet).
- **Receptet laddas i etapper:** ingredienserna visas först, stegen skrivs medan ni plockar fram, sedan kockens noter.
- **Flikar i receptet:** Ingredienser · Gör så här · Dryck · Mer (på laptop ingredienser och steg sida vid sida). Upp till tre recept öppna samtidigt, vart och ett med egna bockar, steg och chatt.
- **Stegen:** ihopfällda med rubrik och början av texten. Tryck för att läsa och klarmarkera, då stryks steget och nästa öppnas.
- **Kockens noter:** märkta Val, Teknik, Inköp, I förväg, Lättare eller Genväg. Val-noter visas vid ingredienserna, övriga vid rätt steg. "Byt till …" ändrar receptet direkt.
- **Dryck på begäran:** sommelierresonemang (vad i rätten som styr, strategi, vad man ska undvika, servering) och länkar till Systembolaget filtrerade på stil, land, druva och er prisklass.
- **Skafferiet:** en engångsinventering per grupp och favoritkök. Vardagsrecept bygger på skafferiet, helgrecept får kräva mer. Skafferivaror som handlas läggs till automatiskt.
- **Jämför med förebilder:** under Mer finns länkar som söker efter rätten hos välkända receptsajter (vardag och helg).
- **Fråga souschefen:** chatt bredvid receptet. Enkla frågor besvaras snabbt, ändringar uppdaterar receptet.
- **Kokboken:** spara, betygsätt och skriv anteckningar. Souschefen läser kokboken och smakminnet.

## Inköpslistan

- **Från receptet:** mängder följer portionerna och summeras (200 g + 300 g = 500 g). Det som finns i skafferiet hamnar under "Har ni troligen hemma".
- **Flera listor** (Mat, Bygghandel, Apotek …) som hela familjen bockar av i realtid. Mataffärslistor sorteras i butiksordning med frysvaror sist.
- **Mataffärsflikar:** Listan · Vanliga (ett tryck lägger till, lärs från tre månaders inköp) · Skafferiet (fyll på det som är slut) · Recept (stryk ett recept, bara dess del av mängden).
- **Tala in eller skriv fritt:** "tacos fredag + kaffe" delas upp i varor på rätt listor av Gemini.
- **I butiken:** handlat försvinner (med Ångra), skärmen hålls tänd och listan fungerar utan täckning.

## Kom igång

1. Logga in med Google och skapa eller gå med i familjen (Inställningar → Konto och familj).
2. Klistra in en gratis Gemini-nyckel från https://aistudio.google.com/apikey under Inställningar. Den delas med familjen, så den behöver bara anges en gång.
3. Lägg Souschefen och inköpslistan på hemskärmen via webbläsarens meny.

## Teknik

Statisk HTML/CSS/JS utan byggsteg på Cloudflare Pages. Data i webbläsaren och i Firestore (`families/{fid}`), inloggning via Firebase. Svarstider per anrop visas under Inställningar → Avancerat.
