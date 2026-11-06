# Dota 2 Market Scanner

Un script JavaScript care inventariază cosmeticele din Dota 2 și estimează valoarea lor pe **Steam Community Market**, direct din consola browserului. Nu necesită instalare, extensii sau chei API.

> **Read-only:** scriptul doar citește inventarul și prețurile. Nu listează, nu vinde și nu transferă iteme.

## Funcționalități

- Încarcă întregul inventar Dota 2 folosind paginarea Steam (`/inventory/{steamId}/570/2`).
- Identifică itemele `marketable` și le grupează după `market_hash_name`, păstrând cantitățile.
- Verifică prețul minim afișat, prețul median și volumul, acolo unde Steam oferă aceste informații.
- Prioritizează pentru verificare itemele cu rarități sau denumiri precum **Arcana**, **Immortal**, **Legendary**, **Mythical** și anumite treasure chests.
- Folosește pauze între solicitări și încearcă din nou în cazul unor erori temporare sau al limitării cererilor.
- Salvează progresul în `localStorage`, separat pentru fiecare SteamID, și evită reverificarea itemelor deja procesate.
- Estimează valoarea netă după comisioanele Steam și Dota 2.
- Exportă rezultatele sortate după valoarea netă estimată într-un fișier CSV.

## Cerințe

- Un browser cu DevTools (de exemplu, Chrome sau Firefox).
- Autentificare în Steam Community.
- Acces la propriul inventar Dota 2.

## Utilizare

1. Deschide [inventarul Dota 2](https://steamcommunity.com/my/inventory/#570) pe `steamcommunity.com`.
2. Deschide **Developer Tools → Console** (`F12`).
3. Copiază conținutul fișierului `dota-market-scanner.js` în consolă și execută-l.
4. Urmărește progresul afișat periodic (de exemplu, `[50/395]`).
5. La final, browserul descarcă automat `dota2-market-valuation.csv`.

Poți opri scanarea fără a pierde datele deja salvate:

```javascript
window.dotaScan.stop();
```

După o întrerupere sau reîncărcarea paginii, rulează din nou scriptul pentru a relua scanarea din cache-ul local. Pentru a exporta din nou rezultatele fără o nouă scanare, cât timp obiectul există în pagina curentă:

```javascript
window.dotaScan.exportCSV();
```

## Configurație

Valorile din versiunea actuală a scriptului sunt:

| Setare | Valoare | Rol |
| --- | --- | --- |
| App ID | `570` | Dota 2 |
| Context ID | `2` | Inventar Steam |
| Monedă | `3` | EUR |
| Țară | `RO` | România |
| Pauză între prețuri | `7000 ms` | Reduce frecvența cererilor |
| Reîncercări pentru HTTP 429 / 5xx | Până la 3 solicitări | Pauze progresive între încercări |
| Salvare progres | `localStorage` | Persistă după reîncărcarea paginii |

Steam poate aplica limite suplimentare; o scanare mare poate dura zeci de minute sau poate fi întreruptă de limitările serviciului.

## Structura CSV

| Coloană | Descriere |
| --- | --- |
| `name` | Numele obiectului pe Steam Market |
| `type` | Tipul / raritatea comunicată de Steam |
| `quantity` | Numărul de exemplare vandabile |
| `lowestEUR` | Cel mai mic preț afișat, în EUR |
| `median` | Prețul median raportat de Steam |
| `volume` | Volumul raportat de Steam |
| `grossEUR` | `lowestEUR × quantity` |
| `estimatedNetEUR` | Suma netă estimată, ținând cont de cantitate |
| `status` | `priced`, `no_data` sau `not_checked` |
| `marketURL` | Link către pagina obiectului din Steam Market |

## Limitări și precizări

- **Estimările nu reprezintă oferte de cumpărare sau vânzări garantate.** Prețul minim se poate modifica.
- Estimarea netă folosește un calcul orientativ al comisioanelor Steam și Dota 2 (5% + 10%, cu comisioane minime și rotunjiri). Suma exactă se verifică la listarea unui item.
- Prețurile salvate în `localStorage` **nu sunt actualizate automat** la reluarea scriptului; o evaluare nouă necesită ștergerea intenționată a cache-ului relevant.
- Scriptul utilizează **EUR** și `country=RO`; pentru alte monede sau regiuni sunt necesare adaptări.
- `marketable` nu este același lucru cu `tradable`.
- Dacă Steam limitează cererile, scriptul se poate opri și va trebui relansat ulterior.
- Nu introduce date de autentificare, parole sau coduri Steam Guard în script. Rulează doar cod pe care l-ai citit și înțeles.
- Este un proiect neoficial, fără afiliere cu Valve sau Steam.

## Exemplu de rezultat

```text
Tipuri de evaluat: 395
[50/395] 12.7% Net estimat evaluat: 20.38 EUR
[395/395] 100.0% Net estimat evaluat: 25.92 EUR
CSV exportat: 395 tipuri
```

*Exemplul ilustrează o execuție anterioară; nu reprezintă valoarea inventarului altui utilizator.*

## Licență

Adaugă un fișier `LICENSE` dacă alegi să publici proiectul sub o licență open-source. Până atunci, nu presupune că este automat licențiat pentru reutilizare.