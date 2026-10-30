# Trust 1 Services Office TV

Office television board for **Trust 1 Services** — heating, cooling, and plumbing in Quincy and Hanover, Massachusetts.

The screen is the Trust 1 mark and a live weather graphic for both towns. Quincy is featured first. The featured town alternates about every 20 seconds, and the other town’s temperature stays visible. Each view shows the current temperature, conditions, feels-like, wind, and humidity, today’s high and low, the next 12 hours, and a five-day forecast. Temperatures are Fahrenheit, wind is miles per hour, and the clock is Eastern time.

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8080
```

Designed at 1920×1080 and scaled to the screen, with type kept inside a margin so it stays clear from 1280×720 through 3840×2160. No build step. No external fonts. Weather comes from [Open-Meteo](https://open-meteo.com/) (no API key). GitHub Pages serves this repository from `main` at the site root:

https://hustl-boards.github.io/Trust1-Office-Board/

The page keeps a single timer, does not grow the document while it runs, and reloads itself about every six hours when the browser is online. Weather refreshes about every 12 minutes. If a fetch fails, the last good reading stays on screen and the board tries again. A screen wake lock is requested when the browser supports it.

Add `?demo=rain-night` to preview a weather scene, or `?freeze=1` to hold the featured town still. Gold on the board is `#FDB714`, taken from the logo.
